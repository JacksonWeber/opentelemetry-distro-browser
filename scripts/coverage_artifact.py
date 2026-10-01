# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Validate an untrusted coverage ZIP and write only its bounded JSON summary."""

import argparse
from pathlib import Path
import stat
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 20 * 1024 * 1024
MAX_SUMMARY_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 4096
SUMMARY_NAME = "coverage-summary.json"


def extract_summary(download_directory: Path, output_directory: Path) -> None:
    files = list(download_directory.iterdir())
    if len(files) != 1:
        raise ValueError("Expected one downloaded coverage archive")
    archive_path = files[0]
    archive_stat = archive_path.lstat()
    if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Coverage archive must be a regular file no larger than 20 MiB")

    with ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            raise ValueError("Coverage archive has too many entries")
        seen = set()
        expanded_bytes = 0
        summary = None
        for entry in entries:
            name = entry.orig_filename
            path = name.removesuffix("/")
            if (
                name != entry.filename
                or "\\" in name
                or ":" in name
                or any(part in ("", ".", "..") for part in path.split("/"))
            ):
                raise ValueError("Unsafe coverage archive entry path")
            if path in seen:
                raise ValueError("Duplicate coverage archive entry")
            seen.add(path)
            expected_type = stat.S_IFDIR if entry.is_dir() else stat.S_IFREG
            if stat.S_IFMT(entry.external_attr >> 16) not in (0, expected_type):
                raise ValueError("Coverage archive contains a link or special file")
            if entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
                raise ValueError("Unsupported coverage archive entry encoding")
            if entry.is_dir() and entry.file_size != 0:
                raise ValueError("Coverage archive directory contains data")
            expanded_bytes += entry.file_size
            if expanded_bytes > MAX_EXPANDED_BYTES:
                raise ValueError("Coverage archive expands beyond 20 MiB")
            if name == SUMMARY_NAME:
                if entry.file_size > MAX_SUMMARY_BYTES:
                    raise ValueError("Coverage summary exceeds 5 MiB")
                summary = entry
        if summary is None:
            raise ValueError("Coverage archive is missing coverage-summary.json")

        # Bound actual reads too, rather than trusting ZIP size metadata alone.
        with archive.open(summary) as source:
            data = source.read(MAX_SUMMARY_BYTES + 1)
        if len(data) > MAX_SUMMARY_BYTES or len(data) != summary.file_size:
            raise ValueError("Invalid decompressed coverage summary size")

    output_directory.mkdir(parents=True, exist_ok=True)
    with (output_directory / SUMMARY_NAME).open("xb") as output:
        output.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("download_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    extract_summary(args.download_directory, args.output_directory)
