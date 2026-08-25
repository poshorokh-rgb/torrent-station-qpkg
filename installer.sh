#!/bin/sh
# Runs ON THE NAS after QTS extracts the payload to a temporary dir.
# Installs TorrentStation into the .qpkg tree and registers it in qpkg.conf.
set -e

SRC_DIR="$(pwd)"     # qinstall.sh cd's here before running us; payload files are here
QPKG_CONF="/etc/config/qpkg.conf"

# Keep the App Center metadata in sync with the package that was actually
# built. qpkg.cfg is part of the signed/extracted payload, so it is the single
# source of truth for the name and version.
[ -r "$SRC_DIR/qpkg.cfg" ] || { echo "[TorrentStation] ERROR: qpkg.cfg is missing from payload" >&2; exit 1; }
. "$SRC_DIR/qpkg.cfg"

detect_volume() {
    for d in /share/CACHEDEV1_DATA /share/CE_CACHEDEV1_DATA /share/MD0_DATA; do
        [ -d "$d" ] && { echo "$d"; return; }
    done
    # fallback: first share/*_DATA dir found
    d="$(ls -d /share/*_DATA 2>/dev/null | head -n1)"
    [ -n "$d" ] && { echo "$d"; return; }
    echo ""
}

if [ -n "${QPKG_INSTALL_PATH:-}" ]; then
    QPKG_ROOT="$QPKG_INSTALL_PATH/$QPKG_NAME"
else
    VOL="$(detect_volume)"
    [ -n "$VOL" ] || { echo "[TorrentStation] ERROR: could not detect data volume under /share"; exit 1; }
    QPKG_ROOT="$VOL/.qpkg/$QPKG_NAME"
fi
echo "[TorrentStation] installing into $QPKG_ROOT"

mkdir -p "$QPKG_ROOT"
cp -a "$SRC_DIR/qpkg.cfg" "$QPKG_ROOT/"
cp -a "$SRC_DIR/shared" "$QPKG_ROOT/"
cp -a "$SRC_DIR/config" "$QPKG_ROOT/"
cp -a "$SRC_DIR/icons" "$QPKG_ROOT/"
cp -a "$SRC_DIR/assets" "$QPKG_ROOT/"
# QTS App Center does not read QPKG_ICON64/80 directly from qpkg.cfg. It
# expects these legacy GIF names in the QPKG root and exposes them through
# /home/httpd/RSS/images. Keep PNG assets for modern surfaces, plus GIFs for
# the native desktop/App Center cache.
cp -f "$QPKG_ROOT/icons/qpkg_icon.gif" "$QPKG_ROOT/.qpkg_icon.gif"
cp -f "$QPKG_ROOT/icons/qpkg_icon_80.gif" "$QPKG_ROOT/.qpkg_icon_80.gif"
cp -f "$QPKG_ROOT/icons/qpkg_icon_gray.gif" "$QPKG_ROOT/.qpkg_icon_gray.gif"
if [ -d /home/httpd/RSS/images ]; then
    # QTS can create these paths as symlinks to the QPKG-root icons. Remove
    # an existing target first; otherwise GNU cp aborts with "are the same
    # file" during an upgrade and the whole package installation is cancelled.
    rm -f "/home/httpd/RSS/images/${QPKG_NAME}.gif"
    rm -f "/home/httpd/RSS/images/${QPKG_NAME}_80.gif"
    rm -f "/home/httpd/RSS/images/${QPKG_NAME}_gray.gif"
    cp -f "$QPKG_ROOT/.qpkg_icon.gif" "/home/httpd/RSS/images/${QPKG_NAME}.gif"
    cp -f "$QPKG_ROOT/.qpkg_icon_80.gif" "/home/httpd/RSS/images/${QPKG_NAME}_80.gif"
    cp -f "$QPKG_ROOT/.qpkg_icon_gray.gif" "/home/httpd/RSS/images/${QPKG_NAME}_gray.gif"
    cp -f "$QPKG_ROOT/assets/app-center-banner.png" "/home/httpd/RSS/images/${QPKG_NAME}_640x400.png"
fi
rm -rf "$QPKG_ROOT/runtime"
cp -a "$SRC_DIR/runtime" "$QPKG_ROOT/"
rm -rf "$QPKG_ROOT/webui"
cp -a "$SRC_DIR/webui" "$QPKG_ROOT/"
chmod 755 "$QPKG_ROOT/shared/TorrentStation.sh"

# Register standard QTS boot hooks. They also recreate /opt/share/transmission
# from the package's own web UI after a reboot; Entware is not involved.
ln -sf "$QPKG_ROOT/shared/$QPKG_SERVICE_PROGRAM" "/etc/init.d/$QPKG_NAME.sh"
ln -sf "/etc/init.d/$QPKG_NAME.sh" "/etc/rcS.d/QS${QPKG_RC_NUM}${QPKG_NAME}"
STOP_RC_NUM="$(expr 1000 - "$QPKG_RC_NUM")"
ln -sf "/etc/init.d/$QPKG_NAME.sh" "/etc/rcK.d/QK${STOP_RC_NUM}${QPKG_NAME}"

# App Center normally creates this section before invoking qinstall. Create a
# minimal one as well, so direct/manual installation and older QTS releases
# follow the same path. Always update it after that, otherwise an upgrade can
# leave an old version disabled or incomplete.
if ! grep -q "^\[$QPKG_NAME\]" "$QPKG_CONF" 2>/dev/null; then
    {
        echo ""
        echo "[$QPKG_NAME]"
        echo "Name = $QPKG_NAME"
    } >> "$QPKG_CONF"
fi

set_qpkg_value() {
    /sbin/setcfg "$QPKG_NAME" "$1" "$2" -f "$QPKG_CONF"
}

echo "[TorrentStation] updating App Center metadata"
set_qpkg_value Name "$QPKG_NAME"
set_qpkg_value Status complete
set_qpkg_value Display_Name "$QPKG_DISPLAY_NAME"
set_qpkg_value Version "$QPKG_VER"
set_qpkg_value Author "$QPKG_AUTHOR"
set_qpkg_value Install_Path "$QPKG_ROOT"
set_qpkg_value QPKG_File "${QPKG_NAME}_${QPKG_VER}_${QPKG_ARCH}.qpkg"
set_qpkg_value Date "$(date '+%F')"
set_qpkg_value WebUI "$QPKG_WEBUI"
set_qpkg_value Web_Port "$QPKG_WEB_PORT"
set_qpkg_value Visible "$QPKG_VISIBLE"
set_qpkg_value FW_Ver_Min "$QTS_MINI_VERSION"
set_qpkg_value Enable TRUE
set_qpkg_value Shell "$QPKG_ROOT/shared/$QPKG_SERVICE_PROGRAM"
set_qpkg_value RC_Number "$QPKG_RC_NUM"

echo "[TorrentStation] (re)starting service"
"$QPKG_ROOT/shared/TorrentStation.sh" restart

echo "[TorrentStation] done. Check $QPKG_ROOT/rpc-credentials.txt for the web UI login."
echo 2 > /tmp/update_process
echo 3 > /tmp/update_process
