#!/bin/sh
# Runs ON THE NAS after makeself extracts the payload to a temp dir.
# Installs TorrentStation into the .qpkg tree and registers it in qpkg.conf.
set -e

QPKG_NAME="TorrentStation"
SRC_DIR="$(pwd)"     # makeself cd's here before running us; payload files are here
QPKG_CONF="/etc/config/qpkg.conf"

detect_volume() {
    for d in /share/CACHEDEV1_DATA /share/CE_CACHEDEV1_DATA /share/MD0_DATA; do
        [ -d "$d" ] && { echo "$d"; return; }
    done
    # fallback: first share/*_DATA dir found
    d="$(ls -d /share/*_DATA 2>/dev/null | head -n1)"
    [ -n "$d" ] && { echo "$d"; return; }
    echo ""
}

VOL="$(detect_volume)"
[ -n "$VOL" ] || { echo "[TorrentStation] ERROR: could not detect data volume under /share"; exit 1; }

QPKG_ROOT="$VOL/.qpkg/$QPKG_NAME"
echo "[TorrentStation] installing into $QPKG_ROOT"

mkdir -p "$QPKG_ROOT"
cp -a "$SRC_DIR/qpkg.cfg" "$QPKG_ROOT/"
cp -a "$SRC_DIR/shared" "$QPKG_ROOT/"
cp -a "$SRC_DIR/config" "$QPKG_ROOT/"
cp -a "$SRC_DIR/icons" "$QPKG_ROOT/"
rm -rf "$QPKG_ROOT/webui"
cp -a "$SRC_DIR/webui" "$QPKG_ROOT/"
chmod 755 "$QPKG_ROOT/shared/TorrentStation.sh"

# Register with App Center's qpkg.conf if not already present.
if ! grep -q "^\[$QPKG_NAME\]" "$QPKG_CONF" 2>/dev/null; then
    echo "[TorrentStation] registering in $QPKG_CONF"
    {
        echo ""
        echo "[$QPKG_NAME]"
        echo "Name = $QPKG_NAME"
        echo "Version = 1.0.0"
        echo "Author = Pavel Shorokh"
        echo "Install_Path = $QPKG_ROOT"
        echo "Install_Date = $(date '+%Y-%m-%d %H:%M:%S')"
        echo "Enable = TRUE"
        echo "Shell = $QPKG_ROOT/shared/TorrentStation.sh"
        echo "RC_Number = 150"
    } >> "$QPKG_CONF"
else
    echo "[TorrentStation] already registered in $QPKG_CONF, skipping"
fi

echo "[TorrentStation] (re)starting service"
"$QPKG_ROOT/shared/TorrentStation.sh" restart

echo "[TorrentStation] done. Check $QPKG_ROOT/rpc-credentials.txt for the web UI login."
