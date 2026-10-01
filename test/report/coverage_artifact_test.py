# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from pathlib import Path
import stat
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import warnings
from zipfile import BadZipFile, ZIP_BZIP2, ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from scripts import coverage_artifact as artifact


class CoverageArtifactTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.archive_path = self.downloads / "artifact"
        self.output = self.root / "output"
        self.summary = b'{"total":{}}'

    def write_archive(self, entries=None, compression=ZIP_DEFLATED):
        if entries is None:
            entries = [(artifact.SUMMARY_NAME, self.summary)]
        with ZipFile(self.archive_path, "w", compression=compression) as archive:
            for name, content in entries:
                archive.writestr(name, content)

    def assert_rejected_before_read(self, message):
        with patch.object(ZipFile, "open", side_effect=AssertionError("Unexpected decompression")):
            with self.assertRaisesRegex(ValueError, message):
                artifact.extract_summary(self.downloads, self.output)
        self.assertFalse(self.output.exists())

    def test_extracts_only_summary_from_stored_and_deflated_archives(self):
        for compression in (ZIP_STORED, ZIP_DEFLATED):
            with self.subTest(compression=compression):
                self.write_archive(
                    [
                        ("lcov-report/", b""),
                        ("lcov-report/index.html", b"report"),
                        (artifact.SUMMARY_NAME, self.summary),
                    ],
                    compression,
                )
                output = self.output / str(compression)
                artifact.extract_summary(self.downloads, output)
                self.assertEqual(list(output.iterdir()), [output / artifact.SUMMARY_NAME])
                self.assertEqual((output / artifact.SUMMARY_NAME).read_bytes(), self.summary)

    def test_accepts_zip64_local_headers(self):
        with ZipFile(self.archive_path, "w", compression=ZIP_DEFLATED) as archive:
            with archive.open(artifact.SUMMARY_NAME, "w", force_zip64=True) as summary:
                summary.write(self.summary)
        artifact.extract_summary(self.downloads, self.output)
        self.assertEqual((self.output / artifact.SUMMARY_NAME).read_bytes(), self.summary)

    def test_accepts_exact_summary_and_total_size_limits(self):
        summary = self.summary.ljust(artifact.MAX_SUMMARY_BYTES, b" ")
        self.write_archive(
            [
                (artifact.SUMMARY_NAME, summary),
                ("lcov.info", b"x" * (artifact.MAX_EXPANDED_BYTES - len(summary))),
            ]
        )
        artifact.extract_summary(self.downloads, self.output)
        self.assertEqual((self.output / artifact.SUMMARY_NAME).read_bytes(), summary)

    def test_rejects_compressed_summary_bomb_before_decompression(self):
        self.write_archive([(artifact.SUMMARY_NAME, b"x" * (artifact.MAX_SUMMARY_BYTES + 1))])
        self.assertLess(self.archive_path.stat().st_size, artifact.MAX_ARCHIVE_BYTES)
        self.assert_rejected_before_read("summary exceeds 5 MiB")

    def test_rejects_excess_total_uncompressed_size_before_reading_summary(self):
        self.write_archive(
            [
                (artifact.SUMMARY_NAME, self.summary),
                ("lcov.info", b"x" * artifact.MAX_EXPANDED_BYTES),
            ]
        )
        self.assertLess(self.archive_path.stat().st_size, artifact.MAX_ARCHIVE_BYTES)
        self.assert_rejected_before_read("expands beyond 20 MiB")

    def test_rejects_unsafe_paths_in_any_entry(self):
        for name in (
            "../outside",
            "/absolute",
            "C:/absolute",
            "report\\outside",
            "report/../outside",
            "report/./file",
            "report//file",
            "report//",
        ):
            with self.subTest(name=name):
                self.write_archive([(artifact.SUMMARY_NAME, self.summary), (name, b"")])
                if "\\" in name:
                    # ZipInfo normalizes Windows separators while writing.
                    data = self.archive_path.read_bytes()
                    self.archive_path.write_bytes(
                        data.replace(name.replace("\\", "/").encode(), name.encode())
                    )
                self.assert_rejected_before_read("Unsafe.*path")

    def test_rejects_null_bytes_in_entry_paths(self):
        self.write_archive([(artifact.SUMMARY_NAME, self.summary), ("report.txt", b"")])
        data = self.archive_path.read_bytes().replace(b"report.txt", b"repor\x00.txt")
        self.archive_path.write_bytes(data)
        self.assert_rejected_before_read("Unsafe.*path")

    def test_rejects_links_and_special_files(self):
        for file_type in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFDIR):
            with self.subTest(file_type=file_type):
                entry = ZipInfo("report")
                entry.create_system = 3
                entry.external_attr = (file_type | 0o644) << 16
                self.write_archive([(artifact.SUMMARY_NAME, self.summary), (entry, b"")])
                self.assert_rejected_before_read("link or special file")

    def test_rejects_directory_payloads(self):
        self.write_archive([(artifact.SUMMARY_NAME, self.summary), ("report/", b"data")])
        self.assert_rejected_before_read("directory contains data")

    def test_rejects_missing_duplicate_and_excess_entries(self):
        self.write_archive([("lcov.info", b"")])
        self.assert_rejected_before_read("missing coverage-summary.json")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            self.write_archive([(artifact.SUMMARY_NAME, self.summary)] * 2)
        self.assert_rejected_before_read("Duplicate")
        self.write_archive([("report", b""), ("report/", b"")])
        self.assert_rejected_before_read("Duplicate")
        self.write_archive([(f"report-{index}", b"") for index in range(artifact.MAX_ENTRIES + 1)])
        self.assert_rejected_before_read("too many entries")

    def test_rejects_encrypted_and_unsupported_entries(self):
        self.write_archive(compression=ZIP_BZIP2)
        self.assert_rejected_before_read("Unsupported")
        self.write_archive()
        data = bytearray(self.archive_path.read_bytes())
        central_header = data.index(b"PK\x01\x02")
        struct.pack_into("<H", data, central_header + 8, 1)
        self.archive_path.write_bytes(data)
        self.assert_rejected_before_read("Unsupported")

    def test_rejects_invalid_or_oversized_archive_files(self):
        self.assert_rejected_before_read("Expected one")
        self.archive_path.mkdir()
        self.assert_rejected_before_read("regular file")
        self.archive_path.rmdir()
        self.archive_path.write_bytes(b"not a zip")
        with self.assertRaises(BadZipFile):
            artifact.extract_summary(self.downloads, self.output)
        with self.archive_path.open("wb") as archive:
            archive.truncate(artifact.MAX_ARCHIVE_BYTES + 1)
        self.assert_rejected_before_read("no larger than 20 MiB")
        (self.downloads / "extra").touch()
        self.assert_rejected_before_read("Expected one")

    def test_bounds_actual_decompression_even_if_metadata_lies(self):
        self.write_archive()
        with patch.object(ZipFile, "open") as open_entry:
            source = open_entry.return_value.__enter__.return_value
            source.read.return_value = b"x" * (artifact.MAX_SUMMARY_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "decompressed.*size"):
                artifact.extract_summary(self.downloads, self.output)
            source.read.assert_called_once_with(artifact.MAX_SUMMARY_BYTES + 1)
        self.assertFalse(self.output.exists())

    def test_checks_summary_crc_before_writing_output(self):
        self.write_archive()
        data = bytearray(self.archive_path.read_bytes())
        central_header = data.index(b"PK\x01\x02")
        struct.pack_into("<I", data, central_header + 16, 0)
        self.archive_path.write_bytes(data)
        with self.assertRaises(BadZipFile):
            artifact.extract_summary(self.downloads, self.output)
        self.assertFalse(self.output.exists())

    def test_cli_reads_both_artifacts_and_fails_for_invalid_input(self):
        self.write_archive()
        script = Path(artifact.__file__)
        for name in ("base", "candidate"):
            output = self.output / name
            result = subprocess.run(
                [sys.executable, str(script), str(self.downloads), str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / artifact.SUMMARY_NAME).read_bytes(), self.summary)
        self.write_archive([("../outside", b"")])
        result = subprocess.run(
            [sys.executable, str(script), str(self.downloads), str(self.output / "invalid")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsafe coverage archive entry path", result.stderr)
        self.assertFalse((self.output / "invalid").exists())


if __name__ == "__main__":
    unittest.main()
