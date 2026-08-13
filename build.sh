#!/bin/sh
# Builds TransmissionQ_<ver>_<arch>.qpkg — a self-extracting installer
# (via makeself) that App Center's "Install Manually" accepts.
set -e

cd "$(dirname "$0")"

. ./qpkg.cfg  # QPKG_NAME, QPKG_VER, QPKG_ARCH, ...

OUT_DIR="build"
QPKG_FILE="${OUT_DIR}/${QPKG_NAME}_${QPKG_VER}_${QPKG_ARCH}.qpkg"
PAYLOAD_DIR="${OUT_DIR}/payload"

if ! command -v makeself >/dev/null 2>&1; then
    echo "makeself not found. Install it with:"
    echo "  brew install makeself"
    exit 1
fi

python3 gen_icons.py

rm -rf "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR"
cp qpkg.cfg "$PAYLOAD_DIR/"
cp -R shared "$PAYLOAD_DIR/"
cp -R config "$PAYLOAD_DIR/"
cp -R icons "$PAYLOAD_DIR/"
cp -R webui "$PAYLOAD_DIR/"
cp installer.sh "$PAYLOAD_DIR/"
chmod +x "$PAYLOAD_DIR/installer.sh" "$PAYLOAD_DIR/shared/${QPKG_SERVICE_PROGRAM}"

makeself --gzip "$PAYLOAD_DIR" "$QPKG_FILE" \
    "${QPKG_NAME} ${QPKG_VER} installer" \
    ./installer.sh

echo ""
echo "Built: $QPKG_FILE"
echo "Copy it to the NAS and install via App Center -> Install Manually,"
echo "or run it directly over SSH: sh $(basename "$QPKG_FILE")"
