#!/bin/sh
# TorrentStation control script — install/start/stop/restart/status
# Called by App Center (via qpkg.cfg's QPKG_SERVICE_PROGRAM) as:
#   TorrentStation.sh {start|stop|restart|status}

QPKG_NAME="TorrentStation"
# App Center invokes this file through /etc/init.d/TorrentStation.sh, which is
# a symlink into the QPKG directory. Resolve links before deriving the root;
# otherwise a boot/start action would incorrectly treat /etc as the package.
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
    LINK_TARGET="$(readlink "$SCRIPT_PATH")"
    case "$LINK_TARGET" in
        /*) SCRIPT_PATH="$LINK_TARGET" ;;
        *) SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$LINK_TARGET" ;;
    esac
done
QPKG_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

OPT=/opt
RUNTIME_DIR="$QPKG_ROOT/runtime/x86_64"
RUNTIME_LIB_DIR="$RUNTIME_DIR/lib"
TR_LOADER="$RUNTIME_LIB_DIR/ld-linux-x86-64.so.2"
TR_DAEMON="$RUNTIME_DIR/bin/transmission-daemon"

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

# Download history — lives on the volume itself, OUTSIDE $QPKG_ROOT, so it
# survives even if the whole .qpkg/TorrentStation folder gets deleted (as
# opposed to living under $DATA_DIR, which would not survive that).
VOL="${QPKG_ROOT%/.qpkg/*}"
HISTORY_DIR="$VOL/.torrentstation-history"
HISTORY_FILE="$HISTORY_DIR/history.jsonl"
HOOKS_DIR="$QPKG_ROOT/shared/hooks"

log() { echo "[TorrentStation] $*"; }
die() { echo "[TorrentStation] ERROR: $*" >&2; exit 1; }

check_runtime() {
    [ -x "$TR_DAEMON" ] || die "bundled transmission-daemon is missing: $TR_DAEMON"
    [ -x "$TR_LOADER" ] || die "bundled runtime loader is missing: $TR_LOADER"
}

run_transmission() {
    # The bundled Transmission was linked against its own glibc. Invoking its
    # loader explicitly makes the QPKG independent from Entware and QTS's
    # system libraries, which may have incompatible versions.
    "$TR_LOADER" --library-path "$RUNTIME_LIB_DIR" "$TR_DAEMON" "$@"
}

gen_password() {
    # 24 random alnum chars, no external deps beyond /dev/urandom
    tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 24
}

ensure_config() {
    mkdir -p "$DATA_DIR" "$DOWNLOAD_DIR" "$INCOMPLETE_DIR" "$WATCH_DIR"
    chmod 700 "$DATA_DIR" 2>/dev/null || true

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
            -e "s#__QPKG_ROOT__#${QPKG_ROOT}#g" \
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

    # Existing installations may have created this file with a permissive
    # process umask, so repair its permissions on every start.
    chmod 600 "$CONF_FILE" 2>/dev/null || die "cannot protect $CONF_FILE"
}

ensure_hook_settings() {
    # settings.json is only written once, on first-ever start (see
    # ensure_config above). The script-torrent-*-enabled/-filename keys were
    # added to the template after some installs already had a settings.json
    # on disk, so a plain reinstall/upgrade never adds them and the history
    # hooks silently never fire. Patch them in if missing, idempotently.
    grep -q '"script-torrent-added-enabled"' "$CONF_FILE" 2>/dev/null && return 0
    log "settings.json predates download-history hooks, patching them in"
    HOOK_BLOCK="$DATA_DIR/.hook-block.$$"
    {
        echo "    \"script-torrent-added-enabled\": true,"
        echo "    \"script-torrent-added-filename\": \"${QPKG_ROOT}/shared/hooks/on-torrent-added.sh\","
        echo "    \"script-torrent-done-enabled\": true,"
        echo "    \"script-torrent-done-filename\": \"${QPKG_ROOT}/shared/hooks/on-torrent-done.sh\","
    } > "$HOOK_BLOCK"
    sed "1r $HOOK_BLOCK" "$CONF_FILE" > "$CONF_FILE.new" && mv "$CONF_FILE.new" "$CONF_FILE"
    rm -f "$HOOK_BLOCK"
    chmod 600 "$CONF_FILE" 2>/dev/null || die "cannot protect $CONF_FILE"
}

ensure_webui() {
    # Overwrite the stock Transmission web UI with ours. Re-run on every
    # start/restart so a future `opkg upgrade transmission-web` (which would
    # restore the stock files) gets clobbered back to our UI on next restart.
    mkdir -p "$WEB_TARGET_DIR"
    cp -a "$WEBUI_DIR"/. "$WEB_TARGET_DIR"/
    # Keep the header's version independent of a hard-coded web UI release.
    # qpkg.cfg is shipped in every package and QPKG_VER is constrained by the
    # package build, so this value is safe to expose as a quoted JS string.
    QPKG_VERSION="$(sed -n 's/^QPKG_VER="\([0-9.][0-9.]*\)"$/\1/p' "$QPKG_ROOT/qpkg.cfg" | head -n 1)"
    [ -n "$QPKG_VERSION" ] || QPKG_VERSION="?"
    printf 'window.TORRENT_STATION_VERSION = "%s";\n' "$QPKG_VERSION" > "$WEB_TARGET_DIR/version.js"
    # Static assets need only be readable by the web server.  In particular,
    # a locally writable app.js would run with every authenticated browser's
    # Transmission session.
    chmod -R go-w "$WEB_TARGET_DIR" 2>/dev/null || true
}

ensure_hooks() {
    # Materialize the on-torrent-added/-done scripts from their templates.
    # Regenerated every start (cheap, keeps them in sync with the template).
    for name in on-torrent-added on-torrent-done; do
        sed "s#__HISTORY_FILE__#${HISTORY_FILE}#g" "$HOOKS_DIR/${name}.sh.template" > "$HOOKS_DIR/${name}.sh"
        chmod 755 "$HOOKS_DIR/${name}.sh"
    done
}

ensure_history() {
    mkdir -p "$HISTORY_DIR"
    [ -f "$HISTORY_FILE" ] || : > "$HISTORY_FILE"
    chmod 700 "$HISTORY_DIR" 2>/dev/null || true
    chmod 600 "$HISTORY_FILE" 2>/dev/null || true
    # Re-sync the web-served copy in case public_html got reset (e.g. by
    # an opkg upgrade of transmission-web).
    cp -f "$HISTORY_FILE" "$WEB_TARGET_DIR/history.jsonl" 2>/dev/null
}

esc_json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'; }

ensure_folders_snapshot() {
    # Feed the folder picker with QNAP's top-level friendly shares only.
    # Recursively following /share can walk millions of media files or block
    # on a sleeping/external volume, which prevented the daemon from starting.
    # Users can still type any nested /share path in Settings.
    FOLDERS_FILE="$WEB_TARGET_DIR/folders.json"
    {
        printf '['
        first=1
        for p in /share/*; do
            [ -e "$p" ] || [ -L "$p" ] || continue
            case "$p" in
                *_DATA|*/.*) continue ;;
            esac
            [ "$first" = 1 ] && first=0 || printf ','
            printf '"%s"' "$(esc_json "$p")"
        done
        printf ']'
    } > "$FOLDERS_FILE" 2>/dev/null
}

read_pid() {
    [ -r "$PID_FILE" ] || return 1
    PID="$(cat "$PID_FILE" 2>/dev/null)"
    case "$PID" in
        ''|*[!0-9]*) return 1 ;;
    esac
    printf '%s\n' "$PID"
}

is_running() {
    PID="$(read_pid)" || return 1
    [ -r "/proc/$PID/cmdline" ] || return 1
    kill -0 "$PID" 2>/dev/null || return 1
    # transmission-daemon is launched through the bundled dynamic loader, so
    # /proc/<pid>/cmdline starts with ld-linux rather than the daemon binary.
    # Match the daemon argument within the NUL-delimited vector instead of
    # relying on a pipeline whose exit status varies between QTS BusyBox builds.
    CMDLINE="$(tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null)"
    case "$CMDLINE" in
        *"$TR_DAEMON"*) return 0 ;;
        *) return 1 ;;
    esac
}

start() {
    check_runtime
    ensure_config
    ensure_hook_settings
    ensure_webui
    ensure_hooks
    ensure_history
    ensure_folders_snapshot

    if is_running; then
        log "already running (pid $(read_pid))"
        return 0
    fi

    log "starting transmission-daemon"
    run_transmission \
        --config-dir "$DATA_DIR" \
        --pid-file "$PID_FILE" \
        --logfile "$LOG_FILE" \
        --log-info \
        --no-portmap \
        --port "$RPC_PORT" >> "$LOG_FILE" 2>&1

    sleep 1
    if is_running; then
        log "started (pid $(read_pid))"
    else
        die "transmission-daemon failed to start, check $LOG_FILE"
    fi
}

stop() {
    if is_running; then
        PID="$(read_pid)"
        log "stopping (pid $PID)"
        kill "$PID"
        for i in 1 2 3 4 5 6 7 8 9 10; do
            is_running || break
            sleep 1
        done
        is_running && kill -9 "$PID" 2>/dev/null
        rm -f "$PID_FILE"
    else
        # A stale or malformed PID file must never be trusted to signal or
        # kill another process after its PID has been reused by the system.
        [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
        log "not running"
    fi
}

restart() {
    stop
    start
}

status() {
    if is_running; then
        echo "TorrentStation is running (pid $(read_pid))"
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
