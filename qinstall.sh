#!/bin/sh
# QPKG control script. QTS extracts this file and data.tar.gz into one
# temporary directory before it is run.
set -eu

cd "$(dirname "$0")"
echo 0 > /tmp/update_process
tar -xzf data.tar.gz
echo 1 > /tmp/update_process
exec /bin/sh ./installer.sh
