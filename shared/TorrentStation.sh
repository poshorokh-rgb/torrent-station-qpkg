#!/bin/sh
# TorrentStation control script — install/start/stop/restart/status
# Called by App Center (via qpkg.cfg's QPKG_SERVICE_PROGRAM) as:
#   TorrentStation.sh {start|stop|restart|status}

QPKG_NAME="TorrentStation"
QPKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

OPT=/opt
OPKG="$OPT/bin/opkg"
TR_DAEMON="$OPT/bin/transmission-daemon"
TR_REMOTE="$OPT/bin/transmission-remote"

WEBUI_DIR="$QPKG_ROOT/webui"                # our custom qBittorrent-styled UI (source)
WEB_TARGET_DIR="$OPT/share/transmission/public_html"  # where transmission-daemon actually serves the UI from
                                             # (this build has no --web-directory flag, so we overwrite the
                                             # stock files here instead — same trick transmission-web-control uses)
DATA_DIR="$QPKG_ROOT/data"                 # transmission --config-dir (settings.json, resume, blocklists)
CONF_FILE="$DATA_DIR/settings.json"
CONF_TEMPLATE="$QPKG_ROOT/config/settings.json.template"
CRED_FILE="$QPKG_ROOT/rpc-credentials.txt"
PID_FILE="$QPKG_ROOT/transmission.pid"
LOG_FILE="$QPKG_ROOT/transmission.log"

DOWNLOAD_DIR="/share/Download/Torrents"
INCOMPLETE_DIR="/share/Download/Torrents/.incomplete"
WATCH_DIR="/share/Download/Torrents/.watch"

RPC_PORT=9091

log() { echo "[TorrentStation] $*"; }
die() { echo "[TorrentStation] ERROR: $*" >&2; exit 1; }

check_entware() {
    [ -x "$OPKG" ] || die "Entware not found at $OPKG. Install Entware first (App Center -> search 'Entware', or see https://github.com/Entware/Entware/wiki/Install-on-QNAP-NAS), then reinstall/start TorrentStation."
}

ensure_transmission_installed() {
    if [ ! -x "$TR_DAEMON" ]; then
        log "transmission-daemon not found under $OPT, installing via opkg..."
        "$OPKG" update || die "opkg update failed (check NAS internet access)"
        "$OPKG" install transmission-daemon transmission-web || die "opkg install transmission-daemon transmission-web failed"
    fi
    [ -x "$TR_DAEMON" ] || die "transmission-daemon still missing after opkg install"
}

gen_password() {
    # 24 random alnum chars, no external deps beyond /dev/urandom
    tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 24
}

ensure_config() {
    mkdir -p "$DATA_DIR" "$DOWNLOAD_DIR" "$INCOMPLETE_DIR" "$WATCH_DIR"

    if [ ! -f "$CONF_FILE" ]; then
        log "First run: generating settings.json"
        RPC_USER="admin"
        RPC_PASS="$(gen_password)"
        [ -n "$RPC_PASS" ] || die "failed to generate RPC password"

        sed \
            -e "s#__DOWNLOAD_DIR__#${DOWNLOAD_DIR}#g" \
            -e "s#__INCOMPLETE_DIR__#${INCOMPLETE_DIR}#g" \
            -e "s#__WATCH_DIR__#${WATCH_DIR}#g" \
            -e "s#__RPC_PORT__#${RPC_PORT}#g" \
            -e "s#__RPC_USER__#${RPC_USER}#g" \
            -e "s#__RPC_PASS__#${RPC_PASS}#g" \
            "$CONF_TEMPLATE" > "$CONF_FILE"

        {
            echo "Torrent Station — Web UI: http://<NAS-IP>:${RPC_PORT}/transmission/web/"
            echo "Username: ${RPC_USER}"
            echo "Password: ${RPC_PASS}"
            echo "(This file is generated once, on first start. Delete settings.json to regenerate.)"
        } > "$CRED_FILE"
        chmod 600 "$CRED_FILE"
        log "Credentials written to $CRED_FILE (chmod 600)"
    fi
}

ensure_webui() {
    # Overwrite the stock Transmission web UI with ours. Re-run on every
    # start/restart so a future `opkg upgrade transmission-web` (which would
    # restore the stock files) gets clobbered back to our UI on next restart.
    mkdir -p "$WEB_TARGET_DIR"
    cp -a "$WEBUI_DIR"/. "$WEB_TARGET_DIR"/
}

is_running() {
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
    check_entware
    ensure_transmission_installed
    ensure_config
    ensure_webui

    if is_running; then
        log "already running (pid $(cat "$PID_FILE"))"
        return 0
    fi

    log "starting transmission-daemon"
    "$TR_DAEMON" \
        --config-dir "$DATA_DIR" \
        --pid-file "$PID_FILE" \
        --logfile "$LOG_FILE" \
        --log-info \
        --no-portmap \
        --port "$RPC_PORT" >> "$LOG_FILE" 2>&1

    sleep 1
    if is_running; then
        log "started (pid $(cat "$PID_FILE"))"
    else
        die "transmission-daemon failed to start, check $LOG_FILE"
    fi
}

stop() {
    if is_running; then
        PID="$(cat "$PID_FILE")"
        log "stopping (pid $PID)"
        kill "$PID"
        for i in 1 2 3 4 5 6 7 8 9 10; do
            is_running || break
            sleep 1
        done
        is_running && kill -9 "$PID" 2>/dev/null
        rm -f "$PID_FILE"
    else
        log "not running"
    fi
}

restart() {
    stop
    start
}

status() {
    if is_running; then
        echo "TorrentStation is running (pid $(cat "$PID_FILE"))"
        exit 0
    else
        echo "TorrentStation is not running"
        exit 1
    fi
}

case "$1" in
    start)   start   ;;
    stop)    stop    ;;
    restart) restart ;;
    status)  status  ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
