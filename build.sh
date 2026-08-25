#!/bin/sh
# Build a QNAP App Center compatible QPKG locally.
# No QDK or build tool is installed on the NAS.
set -eu

cd "$(dirname "$0")"
exec python3 tools/build_qpkg.py
