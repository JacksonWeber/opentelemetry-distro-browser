// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  const minimum =
    major === 22 ? [23, 4] : major === 24 ? [22, 1] : major === 26 ? [12, 1] : undefined;
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !(
      major > 26 ||
      (minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])))
    )
  ) {
    throw new Error(
      `Unsupported Node.js ${version}. Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ ` +
        "on a supported release line to protect against CVE-2026-111497 (Brotli decoder RCE).",
    );
  }
}

assertSupportedNodeVersion();
