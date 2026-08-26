"use strict";

/* ==========================================================================
   RPC CLIENT — talks to Transmission's JSON-RPC endpoint at /transmission/rpc
   Handles the X-Transmission-Session-Id CSRF handshake.

   Auth note: Transmission itself gates the *entire* /transmission/ path
   (static files included) behind HTTP Basic Auth when
   rpc-authentication-required is on. That means the browser's native
   credentials prompt has already succeeded before this script ever runs —
   there's no separate login step to perform here, and the browser resends
   the cached credentials automatically on every same-origin request.
   ========================================================================== */
const RPC_URL = "/transmission/rpc"; // absolute — page lives at /transmission/web/, relative would double up

let sessionId = null;

async function rpc(method, args = {}, _retried = false) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["X-Transmission-Session-Id"] = sessionId;

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ method, arguments: args }),
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 409) {
    sessionId = res.headers.get("X-Transmission-Session-Id");
    if (sessionId && !_retried) return rpc(method, args, true);
    throw new Error("CSRF handshake failed");
  }
  if (res.status === 401) {
    const err = new Error("unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) throw new Error("RPC HTTP " + res.status);

  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error("Invalid RPC response"); }
  if (data.result !== "success") throw new Error(data.result || "RPC error");
  return data.arguments;
}

/* ==========================================================================
   APP ENTRY
   ========================================================================== */
const app = document.getElementById("app");
document.getElementById("app-version").textContent = "v" + (window.TORRENT_STATION_VERSION || "—");

/* ==========================================================================
   FORMATTERS
   ========================================================================== */
function fmtBytes(n) {
  if (n === 0 || n == null) return "0 " + t("unit_b");
  const units = [t("unit_b"), t("unit_kb"), t("unit_mb"), t("unit_gb"), t("unit_tb")];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}
function fmtRate(n) {
  if (!n) return "0 " + t("unit_b") + t("per_sec");
  return fmtBytes(n) + t("per_sec");
}
function fmtEta(s) {
  if (s === -1 || s == null) return t("eta_inf");
  if (s === -2) return t("eta_dash");
  if (s < 60) return s + t("eta_s");
  if (s < 3600) return Math.floor(s / 60) + t("eta_m");
  if (s < 86400) return Math.floor(s / 3600) + t("eta_h") + " " + Math.floor((s % 3600) / 60) + t("eta_m");
  return Math.floor(s / 86400) + t("eta_d") + " " + Math.floor((s % 86400) / 3600) + t("eta_h");
}
function fmtRatio(r) {
  if (r === -1) return t("ratio_inf");
  return r.toFixed(2);
}

function fmtAgo(unixSeconds) {
  if (!unixSeconds) return t("eta_dash");
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return t("just_now");
  if (diff < 3600) return Math.floor(diff / 60) + t("eta_m") + t("ago_suffix");
  if (diff < 86400) return Math.floor(diff / 3600) + t("eta_h") + t("ago_suffix");
  if (diff < 2592000) return Math.floor(diff / 86400) + t("eta_d") + t("ago_suffix");
  const locale = currentLang === "ru" ? "ru-RU" : "en-US";
  return new Date(unixSeconds * 1000).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/* Tracker-reported seed count, summed across trackers (ignores -1 = unknown) */
function seedsOf(tor) {
  return (tor.trackerStats || []).reduce((sum, ts) => sum + (ts.seederCount > 0 ? ts.seederCount : 0), 0);
}

/* status: 0=stopped 1=check-wait 2=checking 3=dl-wait 4=downloading 5=seed-wait 6=seeding */
function statusMeta(status) {
  return {
    0: { label: t("st_paused"), dot: "paused" },
    1: { label: t("st_check_wait"), dot: "check" },
    2: { label: t("st_checking"), dot: "check" },
    3: { label: t("st_dl_wait"), dot: "down" },
    4: { label: t("st_downloading"), dot: "down" },
    5: { label: t("st_seed_wait"), dot: "seed" },
    6: { label: t("st_seeding"), dot: "seed" },
  }[status] || { label: "?", dot: "paused" };
}

/* ==========================================================================
   STATE
   ========================================================================== */
let torrents = [];
let selected = new Set();
let currentFilter = "all";
let currentLabelFilter = null;
let searchTerm = "";
let sortKey = "added";
let sortDir = -1; // newest first
let pollTimer = null;
let freeSpaceTimer = null;
let pollInFlight = false;
let downloadDirCache = null;
let lastStats = null;
let lastFreeBytes = null;
let lastTableStateKey = null;

const els = {
  body: document.getElementById("torrent-body"),
  head: document.getElementById("torrent-head"),
  table: document.querySelector("table.torrents"),
  tableCols: document.getElementById("torrent-cols"),
  tableWrap: document.getElementById("table-wrap"),
  empty: document.getElementById("empty-state"),
  statDown: document.getElementById("stat-down"),
  statUp: document.getElementById("stat-up"),
  statCount: document.getElementById("stat-count"),
  statVersion: document.getElementById("stat-version"),
  freeSpace: document.getElementById("free-space"),
  connDot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
};

/* ==========================================================================
   POLLING
   ========================================================================== */
const FIELDS = [
  "id", "name", "status", "percentDone", "percentComplete", "rateDownload", "rateUpload",
  "eta", "uploadRatio", "peersConnected", "peersSendingToUs", "peersGettingFromUs",
  "totalSize", "sizeWhenDone", "isFinished", "error", "errorString", "downloadDir",
  "addedDate", "doneDate", "downloadedEver", "uploadedEver", "leftUntilDone", "fileCount",
  "isPrivate", "trackerStats", "labels",
];

const TABLE_COLUMNS_KEY = "tq_table_columns_v1";
const TABLE_COLUMNS = [
  { id: "name", label: "col_name", sort: "name", fixed: true, defaultWidth: 320, minWidth: 180, cell: (tor) => {
    const error = tor.error && tor.error !== 0;
    const title = error ? ` title="${escapeHtml(tor.errorString || t("st_error"))}"` : "";
    const labels = (tor.labels || []).filter((label) => !isFocusLabel(label));
    return `<td class="name-cell"${title}><div class="fname">${escapeHtml(tor.name)}</div>${labels.map((label) => `<span class="label-chip">${escapeHtml(label)}</span>`).join("")}</td>`;
  } },
  { id: "size", label: "col_size", sort: "size", num: true, defaultWidth: 92, minWidth: 72, cell: (tor) => `<td class="num">${fmtBytes(tor.totalSize)}</td>` },
  { id: "progress", label: "col_progress", sort: "progress", defaultWidth: 132, minWidth: 124, cell: (tor) => {
    const pct = Math.round(torrentProgress(tor) * 100);
    const color = tor.status === 6 ? "var(--progress-green)" : tor.status === 0 ? "var(--progress-faint)" : "var(--progress-amber)";
    return `<td><div class="progress-track"><div class="progress-fill" style="width:${pct}%; --fill-c:${color}"></div><div class="progress-pct">${pct}%</div></div></td>`;
  } },
  { id: "status", label: "col_status", sort: "status", defaultWidth: 118, minWidth: 94, cell: (tor) => {
    const meta = statusMeta(tor.status);
    const error = tor.error && tor.error !== 0;
    return `<td><span class="status-pill"><span class="dot ${error ? "error" : meta.dot}"></span>${error ? t("st_error") : meta.label}</span></td>`;
  } },
  { id: "added", label: "col_added", sort: "added", num: true, defaultWidth: 98, minWidth: 82, cell: (tor) => `<td class="num" title="${escapeHtml(fmtDate(tor.addedDate))}">${fmtAgo(tor.addedDate)}</td>` },
  { id: "added_date", label: "col_added_date", sort: "addedDate", num: true, defaultWidth: 142, minWidth: 125, cell: (tor) => `<td class="num">${escapeHtml(fmtDate(tor.addedDate))}</td>` },
  { id: "down", label: "col_down", sort: "down", num: true, defaultWidth: 108, minWidth: 94, cell: (tor) => `<td class="num ${tor.rateDownload ? "rate-down" : "rate-zero"}">${tor.rateDownload ? fmtRate(tor.rateDownload) : "—"}</td>` },
  { id: "up", label: "col_up", sort: "up", num: true, defaultWidth: 108, minWidth: 94, cell: (tor) => `<td class="num ${tor.rateUpload ? "rate-up" : "rate-zero"}">${tor.rateUpload ? fmtRate(tor.rateUpload) : "—"}</td>` },
  { id: "eta", label: "col_eta", sort: "eta", num: true, defaultWidth: 82, minWidth: 66, cell: (tor) => `<td class="num">${tor.status === 4 ? fmtEta(tor.eta) : "—"}</td>` },
  { id: "ratio", label: "col_ratio", sort: "ratio", num: true, defaultWidth: 74, minWidth: 62, cell: (tor) => `<td class="num">${fmtRatio(tor.uploadRatio)}</td>` },
  { id: "peers", label: "col_peers", sort: "peers", num: true, defaultWidth: 96, minWidth: 78, cell: (tor) => `<td class="num">${seedsOf(tor)}/${tor.peersConnected}</td>` },
  { id: "downloaded", label: "col_downloaded", sort: "downloaded", num: true, defaultWidth: 112, minWidth: 94, cell: (tor) => `<td class="num">${fmtBytes(tor.downloadedEver)}</td>` },
  { id: "uploaded", label: "col_uploaded", sort: "uploaded", num: true, defaultWidth: 112, minWidth: 94, cell: (tor) => `<td class="num">${fmtBytes(tor.uploadedEver)}</td>` },
  { id: "remaining", label: "col_remaining", sort: "remaining", num: true, defaultWidth: 124, minWidth: 102, cell: (tor) => `<td class="num">${tor.leftUntilDone ? fmtBytes(tor.leftUntilDone) : "—"}</td>` },
  { id: "location", label: "col_location", sort: "location", defaultWidth: 250, minWidth: 140, cell: (tor) => `<td class="location-cell" title="${escapeHtml(tor.downloadDir || "")}">${escapeHtml(tor.downloadDir || "—")}</td>` },
  { id: "completed", label: "col_completed", sort: "completed", num: true, defaultWidth: 142, minWidth: 125, cell: (tor) => `<td class="num" title="${escapeHtml(tor.doneDate ? fmtDate(tor.doneDate) : "")}">${tor.doneDate ? fmtAgo(tor.doneDate) : "—"}</td>` },
  { id: "files", label: "col_files", sort: "files", num: true, defaultWidth: 74, minWidth: 60, cell: (tor) => `<td class="num">${Number.isFinite(tor.fileCount) ? tor.fileCount : "—"}</td>` },
  { id: "private", label: "col_private", sort: "private", defaultWidth: 88, minWidth: 70, cell: (tor) => `<td>${tor.isPrivate ? t("yes") : t("no")}</td>` },
  { id: "error", label: "col_error", sort: "error", defaultWidth: 230, minWidth: 120, cell: (tor) => `<td class="error-cell" title="${escapeHtml(tor.errorString || "")}">${escapeHtml(tor.errorString || "—")}</td>` },
];
const DEFAULT_TABLE_COLUMN_IDS = ["name", "size", "progress", "status", "added", "down", "up", "eta", "ratio", "peers"];

function defaultTableColumns() {
  return { order: TABLE_COLUMNS.map((column) => column.id), visible: DEFAULT_TABLE_COLUMN_IDS, widths: {} };
}

function loadTableColumns() {
  const defaults = defaultTableColumns();
  try {
    const saved = JSON.parse(localStorage.getItem(TABLE_COLUMNS_KEY));
    if (!saved || !Array.isArray(saved.order) || !Array.isArray(saved.visible)) return defaults;
    const known = new Set(TABLE_COLUMNS.map((column) => column.id));
    const order = saved.order.filter((id) => known.has(id));
    for (const column of TABLE_COLUMNS) if (!order.includes(column.id)) order.push(column.id);
    const visible = saved.visible.filter((id) => known.has(id) && id !== "name");
    const widths = {};
    if (saved.widths && typeof saved.widths === "object") {
      for (const column of TABLE_COLUMNS) {
        const width = Number(saved.widths[column.id]);
        if (Number.isFinite(width) && width >= column.minWidth && width <= 1200) widths[column.id] = Math.round(width);
      }
    }
    return { order: ["name", ...order.filter((id) => id !== "name")], visible: ["name", ...visible], widths };
  } catch (e) {
    return defaults;
  }
}

let tableColumns = loadTableColumns();

function visibleTableColumns() {
  const visible = new Set(tableColumns.visible);
  return tableColumns.order
    .map((id) => TABLE_COLUMNS.find((column) => column.id === id))
    .filter((column) => column && (column.fixed || visible.has(column.id)));
}

function saveTableColumns() {
  localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(tableColumns));
}

function tableColumnWidth(column) {
  return tableColumns.widths[column.id] || column.defaultWidth;
}

function renderTableGeometry() {
  const columns = visibleTableColumns();
  els.tableCols.innerHTML = columns.map((column) => `<col data-column-id="${column.id}" style="width:${tableColumnWidth(column)}px">`).join("");
  syncTableWidth();
}

function syncTableWidth() {
  const width = visibleTableColumns().reduce((total, column) => total + tableColumnWidth(column), 0);
  els.table.style.width = Math.max(els.tableWrap.clientWidth, width) + "px";
}

const columnsControl = document.querySelector(".columns-control");
const columnsButton = document.getElementById("btn-columns");
const columnsMenu = document.getElementById("columns-menu");
const columnsList = document.getElementById("columns-list");

function renderTableHeader() {
  els.head.innerHTML = visibleTableColumns().map((column) => `
    <th data-sort="${column.sort}" data-column-id="${column.id}"${column.num ? ' class="num"' : ""}>
      ${column.id === "peers"
        ? `<span class="peers-sort-label"><span data-peer-sort="seeds">${escapeHtml(t("col_seeds_short"))}</span><span class="peers-sort-separator">/</span><span data-peer-sort="peers">${escapeHtml(t("col_peers_short"))}</span></span>`
        : `<span>${escapeHtml(t(column.label))}</span>`} <span class="arrow"></span>
      <span class="column-resizer" data-column-resize="${column.id}" aria-hidden="true"></span>
    </th>`).join("");
  renderTableGeometry();
  markSortIndicator();
}

function renderColumnsMenu() {
  const visible = new Set(tableColumns.visible);
  columnsList.innerHTML = tableColumns.order.map((id, index) => {
    const column = TABLE_COLUMNS.find((item) => item.id === id);
    if (!column) return "";
    const checked = column.fixed || visible.has(column.id);
    return `<div class="column-option${checked ? "" : " is-hidden"}">
      <label><input type="checkbox" data-column-toggle="${column.id}"${checked ? " checked" : ""}${column.fixed ? " disabled" : ""}><span>${escapeHtml(t(column.label))}</span></label>
      <span class="column-move">
        <button type="button" data-column-move="up" data-column-id="${column.id}" title="↑"${column.fixed || index <= 1 ? " disabled" : ""}>↑</button>
        <button type="button" data-column-move="down" data-column-id="${column.id}" title="↓"${column.fixed || index === tableColumns.order.length - 1 ? " disabled" : ""}>↓</button>
      </span>
    </div>`;
  }).join("");
}

function applyTableColumns() {
  saveTableColumns();
  lastTableStateKey = null;
  renderTableHeader();
  renderColumnsMenu();
  renderTable();
}

function moveTableColumn(id, direction) {
  const index = tableColumns.order.indexOf(id);
  const target = index + direction;
  if (index <= 0 || target <= 0 || target >= tableColumns.order.length) return;
  [tableColumns.order[index], tableColumns.order[target]] = [tableColumns.order[target], tableColumns.order[index]];
  applyTableColumns();
}

function closeColumnsMenu() {
  columnsMenu.hidden = true;
  columnsButton.setAttribute("aria-expanded", "false");
}

// percentDone is based on the files currently marked Wanted. In Focus mode
// that can be a single file, so use percentComplete for the progress of the
// whole torrent. The fallback keeps the UI usable with older daemons.
function torrentProgress(tor) {
  const progress = Number.isFinite(tor.percentComplete) ? tor.percentComplete : tor.percentDone;
  return Math.max(0, Math.min(1, progress || 0));
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const [tArgs, stats] = await Promise.all([
      rpc("torrent-get", { fields: FIELDS }),
      rpc("session-stats"),
    ]);
    torrents = tArgs.torrents;
    setConn(true);
    renderStats(stats);
    renderSidebarCounts();
    renderLabelFilters();
    renderTable();

    if (!downloadDirCache) {
      const s = await rpc("session-get");
      downloadDirCache = s["download-dir"];
      els.statVersion.textContent = "Transmission " + (s.version || "");
      refreshFreeSpace();
    }
  } catch (e) {
    if (e.code === 401) {
      // Cached Basic Auth credentials were rejected (rare — e.g. password
      // changed on the daemon side). Reloading makes the browser re-prompt.
      stopPolling();
      toast(t("toast_reauth"), "error");
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    setConn(false);
  } finally {
    pollInFlight = false;
  }
}

async function refreshFreeSpace() {
  if (!downloadDirCache) return;
  try {
    const r = await rpc("free-space", { path: downloadDirCache });
    lastFreeBytes = r["size-bytes"];
    els.freeSpace.querySelector(".count").textContent = fmtBytes(lastFreeBytes);
  } catch (e) { /* ignore */ }
}

function setConn(ok) {
  els.connDot.style.background = ok ? "var(--green)" : "var(--red)";
  els.connText.textContent = ok ? t("conn_ok") : t("conn_bad");
}

/* Re-render everything with the new language, using last-known data (no RPC round-trip) */
function onLangChanged() {
  if (lastStats) renderStats(lastStats);
  if (lastFreeBytes != null) els.freeSpace.querySelector(".count").textContent = fmtBytes(lastFreeBytes);
  if (torrents.length || document.getElementById("app").classList.contains("active")) {
    renderSidebarCounts();
    renderTable();
  }
  if (currentDetailsId != null) fetchDetails();
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, 2000);
  freeSpaceTimer = setInterval(refreshFreeSpace, 15000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (freeSpaceTimer) clearInterval(freeSpaceTimer);
  pollTimer = null;
  freeSpaceTimer = null;
}

/* ==========================================================================
   RENDER: stats bar + sidebar counts
   ========================================================================== */
function renderStats(stats) {
  lastStats = stats;
  els.statDown.textContent = fmtRate(stats.downloadSpeed);
  els.statUp.textContent = fmtRate(stats.uploadSpeed);
  els.statCount.textContent = stats.torrentCount;
}

function renderSidebarCounts() {
  const c = { all: torrents.length, downloading: 0, seeding: 0, active: 0, paused: 0, checking: 0, completed: 0, error: 0 };
  for (const tor of torrents) {
    if (tor.status === 4) c.downloading++;
    if (tor.status === 6) c.seeding++;
    if (tor.status === 4 || tor.status === 6) c.active++;
    if (tor.status === 0) c.paused++;
    if (tor.status === 1 || tor.status === 2) c.checking++;
    if (torrentProgress(tor) >= 1) c.completed++;
    if (tor.error && tor.error !== 0) c.error++;
  }
  for (const k in c) {
    const el = document.getElementById("cnt-" + k);
    if (el) el.textContent = c[k];
  }
}

/* Labels are a first-class Transmission 3+ feature, so categories do not
   live in localStorage: they remain available in every web client. */
function renderLabelFilters() {
  const counts = new Map();
  let uncategorized = 0;
  for (const tor of torrents) {
    const labels = (Array.isArray(tor.labels) ? tor.labels : []).filter((label) => !isFocusLabel(label));
    if (!labels.length) uncategorized++;
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  }
  const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, currentLang));
  const out = document.getElementById("label-filters");
  out.innerHTML = [
    ...(uncategorized ? [["", uncategorized]] : []),
    ...items,
  ].map(([label, count]) => `<div class="label-filter${currentLabelFilter === label ? " active" : ""}" data-label="${escapeHtml(label)}" title="${escapeHtml(label || t("sb_uncategorized"))}">
      <span class="dot ${label ? "active" : "paused"}"></span><span class="label-name">${escapeHtml(label || t("sb_uncategorized"))}</span><span class="count">${count}</span>
    </div>`).join("");
  if (currentLabelFilter !== null && !counts.has(currentLabelFilter) && currentLabelFilter !== "") currentLabelFilter = null;
  document.getElementById("category-suggestions").innerHTML = items
    .map(([label]) => `<option value="${escapeHtml(label)}"></option>`).join("");
}

/* ==========================================================================
   RENDER: table
   ========================================================================== */
function matchesFilter(tor) {
  if (currentLabelFilter !== null) {
    const labels = (Array.isArray(tor.labels) ? tor.labels : []).filter((label) => !isFocusLabel(label));
    if (currentLabelFilter ? !labels.includes(currentLabelFilter) : labels.length) return false;
  }
  switch (currentFilter) {
    case "downloading": return tor.status === 4;
    case "seeding": return tor.status === 6;
    case "active": return tor.status === 4 || tor.status === 6;
    case "paused": return tor.status === 0;
    case "checking": return tor.status === 1 || tor.status === 2;
    case "completed": return torrentProgress(tor) >= 1;
    case "error": return tor.error && tor.error !== 0;
    default: return true;
  }
}

function sortedFiltered() {
  let list = torrents.filter(matchesFilter);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter((tor) => tor.name.toLowerCase().includes(q));
  }
  const keyFn = {
    name: (tor) => tor.name.toLowerCase(),
    size: (tor) => tor.totalSize,
    progress: torrentProgress,
    status: (tor) => tor.status,
    added: (tor) => tor.addedDate,
    addedDate: (tor) => tor.addedDate,
    down: (tor) => tor.rateDownload,
    up: (tor) => tor.rateUpload,
    eta: (tor) => (tor.eta < 0 ? Infinity : tor.eta),
    ratio: (tor) => tor.uploadRatio,
    peers: (tor) => tor.peersConnected,
    seeds: seedsOf,
    downloaded: (tor) => tor.downloadedEver,
    uploaded: (tor) => tor.uploadedEver,
    remaining: (tor) => tor.leftUntilDone,
    location: (tor) => tor.downloadDir || "",
    completed: (tor) => tor.doneDate || 0,
    files: (tor) => tor.fileCount || 0,
    private: (tor) => tor.isPrivate ? 1 : 0,
    error: (tor) => tor.error || 0,
  }[sortKey];
  list.sort((a, b) => {
    const av = keyFn(a), bv = keyFn(b);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return list;
}

function tableStateKey() {
  // Include exactly the values that can change a table row or its ordering.
  // This is much cheaper than destroying and rebuilding the DOM on every poll.
  const rows = torrents.map((tor) => [
    tor.id, tor.name, tor.status, torrentProgress(tor), tor.error, tor.errorString,
    tor.totalSize, tor.addedDate, tor.doneDate, tor.rateDownload, tor.rateUpload, tor.eta,
    tor.uploadRatio, tor.peersConnected, tor.downloadedEver, tor.uploadedEver, tor.leftUntilDone,
    tor.downloadDir, tor.fileCount, tor.isPrivate,
    (tor.labels || []).join("\u001f"),
    (tor.trackerStats || []).map((ts) => ts.seederCount).join(","),
  ].join("\u001e")).join("\u001d");
  return [
    currentLang, currentFilter, currentLabelFilter, searchTerm, sortKey, sortDir,
    tableColumns.order.join(","), tableColumns.visible.join(","),
    Array.from(selected).sort((a, b) => a - b).join(","), rows,
  ].join("\u001c");
}

function renderTable() {
  // reconcile selection with still-present ids
  const presentIds = new Set(torrents.map((tor) => tor.id));
  for (const id of Array.from(selected)) if (!presentIds.has(id)) selected.delete(id);
  updateToolbarState();
  syncTableWidth();

  const stateKey = tableStateKey();
  if (stateKey === lastTableStateKey) return;
  lastTableStateKey = stateKey;

  const list = sortedFiltered();
  els.empty.style.display = list.length ? "none" : "flex";
  els.body.innerHTML = list.map(rowHtml).join("");
}

function rowHtml(tor) {
  const isSel = selected.has(tor.id) ? "selected" : "";
  return `<tr class="${isSel}" data-id="${tor.id}">${visibleTableColumns().map((column) => column.cell(tor)).join("")}</tr>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/* ==========================================================================
   SELECTION
   ========================================================================== */
let lastClickedId = null;
let lastRowClick = { id: null, time: 0 };

els.body.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const list = sortedFiltered().map((tor) => tor.id);
  const now = Date.now();
  const isDoubleClick = lastRowClick.id === id && now - lastRowClick.time < 450;

  if (e.shiftKey && lastClickedId != null) {
    const a = list.indexOf(lastClickedId), b = list.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selected.add(list[i]);
  } else if (e.metaKey || e.ctrlKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
  } else {
    selected = new Set([id]);
  }
  lastClickedId = id;
  lastRowClick = { id, time: now };
  renderTable();
  if (isDoubleClick) {
    lastRowClick = { id: null, time: 0 };
    openDetails(id);
  }
});

function updateToolbarState() {
  const has = selected.size > 0;
  document.getElementById("btn-resume").disabled = !has;
  document.getElementById("btn-pause").disabled = !has;
  document.getElementById("btn-remove").disabled = !has;
}

/* ==========================================================================
   TOOLBAR ACTIONS
   ========================================================================== */
document.getElementById("btn-resume").addEventListener("click", () => act("torrent-start"));
document.getElementById("btn-pause").addEventListener("click", () => act("torrent-stop"));
document.getElementById("btn-remove").addEventListener("click", () => openRemoveConfirm(false));
document.getElementById("btn-categories").addEventListener("click", () => openCategories());

async function act(method, extra = {}) {
  if (!selected.size) return;
  try {
    await rpc(method, { ids: Array.from(selected), ...extra });
    toast(method === "torrent-start" ? t("toast_started") : method === "torrent-stop" ? t("toast_paused") : t("toast_done"));
    poll();
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
}

/* Categories are Transmission labels. Editing them here writes directly to
   the selected torrents, so the result is shared with other clients too. */
const modalCategories = document.getElementById("modal-categories");
const categoriesTitle = document.getElementById("categories-dialog-title");
const categoriesSelectedLabel = document.getElementById("categories-selected-label");
const categoriesSelectedEl = document.getElementById("categories-selected");
const categoriesQuickSection = document.getElementById("categories-quick-section");
const categoriesQuickEl = document.getElementById("categories-quick");
const categoriesSearch = document.getElementById("categories-search");
const categoriesSearchResults = document.getElementById("categories-search-results");
const categoriesNew = document.getElementById("categories-new");
let categoryTargetIds = [];
let categoryDraftLabels = [];
let categoryEditorMode = "assign";

const CATEGORY_CATALOG_KEY = "tq_category_catalog_v1";
const DEFAULT_CATEGORY_CATALOG = ["Сериалы", "Фильмы", "Документалки", "4K"];

function categoryKey(label) {
  return String(label).trim().toLocaleLowerCase(currentLang);
}

function normalizeCategory(label) {
  return String(label).replace(/\s+/g, " ").trim();
}

function uniqueCategories(labels) {
  const seen = new Set();
  return labels.map(normalizeCategory).filter((label) => {
    const key = categoryKey(label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadCategoryCatalog() {
  try {
    const stored = JSON.parse(localStorage.getItem(CATEGORY_CATALOG_KEY));
    if (Array.isArray(stored)) return uniqueCategories(stored);
  } catch (e) { /* use the initial catalog */ }
  return [...DEFAULT_CATEGORY_CATALOG];
}

let categoryCatalog = loadCategoryCatalog();

function saveCategoryCatalog() {
  try { localStorage.setItem(CATEGORY_CATALOG_KEY, JSON.stringify(categoryCatalog)); }
  catch (e) { toast(t("toast_error") + e.message, "error"); }
}

function addToCategoryCatalog(label) {
  const before = categoryCatalog.length;
  categoryCatalog = uniqueCategories([...categoryCatalog, label]);
  if (categoryCatalog.length !== before) saveCategoryCatalog();
}

function removeFromCategoryCatalog(label) {
  const key = categoryKey(label);
  categoryCatalog = categoryCatalog.filter((item) => categoryKey(item) !== key);
  saveCategoryCatalog();
}

function visibleLabelsOf(tor) {
  return (tor.labels || []).filter((label) => !isFocusLabel(label));
}

function knownCategories() {
  const labels = [...categoryCatalog];
  torrents.forEach((tor) => labels.push(...visibleLabelsOf(tor)));
  return uniqueCategories(labels).sort((a, b) => a.localeCompare(b, currentLang));
}

function categoryButton(label, action, active = false) {
  const removable = action === "remove" || action === "catalog-remove";
  return `<button type="button" class="category-chip${active ? " active" : ""}" data-category-action="${action}" data-category="${escapeHtml(label)}"${action === "choose" ? ` aria-pressed="${active}"` : ""}>${escapeHtml(label)}${removable ? '<span aria-hidden="true">×</span>' : ""}</button>`;
}

function categorySearchResult(label) {
  const active = (categoryEditorMode === "catalog" ? categoryCatalog : categoryDraftLabels)
    .some((item) => categoryKey(item) === categoryKey(label));
  return `<span class="category-search-result">${categoryButton(label, "choose", active)}<button type="button" class="category-delete-button" data-category-delete="${escapeHtml(label)}" title="${escapeHtml(t("categories_delete_action"))}" aria-label="${escapeHtml(t("categories_delete_action"))}">×</button></span>`;
}

function renderCategoryEditor() {
  const displayed = categoryEditorMode === "catalog" ? categoryCatalog : categoryDraftLabels;
  categoriesSelectedEl.innerHTML = displayed.length
    ? displayed.map((label) => categoryButton(label, categoryEditorMode === "catalog" ? "catalog-remove" : "remove")).join("")
    : `<span class="category-empty">${escapeHtml(t("categories_empty"))}</span>`;
  categoriesQuickEl.innerHTML = categoryCatalog.map((label) =>
    categoryButton(label, "choose", categoryDraftLabels.some((item) => categoryKey(item) === categoryKey(label)))
  ).join("");

  const query = normalizeCategory(categoriesSearch.value).toLocaleLowerCase(currentLang);
  const matches = query ? knownCategories().filter((label) =>
    label.toLocaleLowerCase(currentLang).includes(query)
  ) : [];
  categoriesSearchResults.innerHTML = matches.length
    ? matches.map(categorySearchResult).join("")
    : query ? `<span class="category-empty">${escapeHtml(t("categories_no_matches"))}</span>` : "";
}

function addCategoryToDraft(value) {
  const label = normalizeCategory(value);
  if (!label) return;
  if (/\r|\n/.test(label)) { toast(t("toast_invalid_category"), "error"); return; }
  addToCategoryCatalog(label);
  if (categoryEditorMode === "assign") categoryDraftLabels = uniqueCategories([...categoryDraftLabels, label]);
  renderCategoryEditor();
}

function openCategories(targetIds) {
  const ids = Array.isArray(targetIds) ? [...new Set(targetIds)] : Array.from(selected);
  const picked = torrents.filter((tor) => ids.includes(tor.id));
  categoryEditorMode = picked.length ? "assign" : "catalog";
  categoriesQuickSection.hidden = categoryEditorMode === "catalog";
  document.getElementById("categories-save").hidden = categoryEditorMode === "catalog";
  categoriesSelectedLabel.textContent = t(categoryEditorMode === "catalog" ? "categories_catalog" : "categories_selected");
  categoriesSearch.value = "";
  categoriesNew.value = "";
  if (categoryEditorMode === "catalog") {
    categoryTargetIds = [];
    categoryDraftLabels = [];
    categoriesTitle.textContent = t("categories_catalog_title");
    renderCategoryEditor();
    modalCategories.classList.add("show");
    setTimeout(() => categoriesSearch.focus(), 50);
    return;
  }
  categoryTargetIds = picked.map((tor) => tor.id);
  const first = picked[0] || { labels: [] };
  const sameLabels = picked.every((tor) => JSON.stringify(visibleLabelsOf(tor)) === JSON.stringify(visibleLabelsOf(first)));
  categoryDraftLabels = sameLabels ? uniqueCategories(visibleLabelsOf(first)) : [];
  categoriesSearch.value = "";
  categoriesNew.value = "";
  categoriesTitle.textContent = picked.length === 1
    ? tf("categories_for", first.name)
    : tf("categories_for_many", picked.length);
  renderCategoryEditor();
  modalCategories.classList.add("show");
  setTimeout(() => categoriesSearch.focus(), 50);
}
function closeCategories() {
  modalCategories.classList.remove("show");
  categoryTargetIds = [];
  categoryDraftLabels = [];
  categoryEditorMode = "assign";
  categoriesQuickSection.hidden = false;
  document.getElementById("categories-save").hidden = false;
  categoriesSelectedLabel.textContent = t("categories_selected");
  categoriesTitle.textContent = t("categories_title");
}

document.getElementById("categories-close").addEventListener("click", closeCategories);
document.getElementById("categories-cancel").addEventListener("click", closeCategories);
modalCategories.addEventListener("click", (e) => { if (e.target === modalCategories) closeCategories(); });
modalCategories.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-category-delete]");
  if (deleteButton) {
    openCategoryDelete(deleteButton.dataset.categoryDelete);
    return;
  }
  const button = event.target.closest("[data-category-action]");
  if (!button) return;
  const label = button.dataset.category;
  const action = button.dataset.categoryAction;
  if (action === "catalog-remove") {
    openCategoryDelete(label);
    return;
  }
  if (categoryEditorMode === "catalog") {
    addToCategoryCatalog(label);
    renderCategoryEditor();
    return;
  }
  const selectedAlready = categoryDraftLabels.some((item) => categoryKey(item) === categoryKey(label));
  if (action === "remove" || selectedAlready) {
    categoryDraftLabels = categoryDraftLabels.filter((item) => categoryKey(item) !== categoryKey(label));
  } else {
    categoryDraftLabels = uniqueCategories([...categoryDraftLabels, label]);
    addToCategoryCatalog(label);
  }
  renderCategoryEditor();
});
categoriesSearch.addEventListener("input", renderCategoryEditor);
document.getElementById("categories-add").addEventListener("click", () => {
  addCategoryToDraft(categoriesNew.value);
  categoriesNew.value = "";
});
categoriesNew.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("categories-add").click();
  }
});
document.getElementById("categories-save").addEventListener("click", async () => {
  const labels = categoryDraftLabels;
  const targets = torrents.filter((tor) => categoryTargetIds.includes(tor.id));
  if (!targets.length) { closeCategories(); return; }
  const refreshDetails = currentDetailsId != null && categoryTargetIds.includes(currentDetailsId);
  try {
    // Focus is represented by an internal label. Preserve it while changing
    // user-visible categories, otherwise a category edit could prevent the
    // monitor from restoring temporarily skipped files.
    await Promise.all(targets.map((tor) => rpc("torrent-set", {
      ids: [tor.id],
      labels: [...labels, ...(tor.labels || []).filter(isFocusLabel)],
    })));
    closeCategories();
    toast(t("categories_saved"), "success");
    poll();
    if (refreshDetails) fetchDetails();
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
});

const modalCategoryDelete = document.getElementById("modal-category-delete");
const categoryDeleteMessage = document.getElementById("category-delete-message");
const categoryDeleteSubmit = document.getElementById("category-delete-submit");
let categoryDeleteLabel = null;
let categoryDeleteTargets = [];

function categoryTorrents(label, source = torrents) {
  const key = categoryKey(label);
  return source.filter((tor) => visibleLabelsOf(tor).some((item) => categoryKey(item) === key));
}

async function openCategoryDelete(label) {
  categoryDeleteLabel = label;
  categoryDeleteTargets = [];
  categoryDeleteMessage.textContent = t("categories_delete_checking");
  categoryDeleteSubmit.disabled = true;
  modalCategoryDelete.classList.add("show");
  try {
    // The table poll is deliberately lightweight and can be stale. Query the
    // daemon here, so a category with real assignments never looks empty.
    const data = await rpc("torrent-get", { fields: ["id", "labels"] });
    const targets = categoryTorrents(label, data.torrents || []);
    if (categoryDeleteLabel !== label) return;
    categoryDeleteLabel = label;
    categoryDeleteTargets = targets;
    categoryDeleteMessage.textContent = targets.length
      ? tf("categories_delete_message", label, targets.length)
      : tf("categories_delete_empty_message", label);
    categoryDeleteSubmit.disabled = false;
  } catch (e) {
    if (categoryDeleteLabel === label) categoryDeleteMessage.textContent = t("toast_error") + e.message;
  }
}

function closeCategoryDelete() {
  modalCategoryDelete.classList.remove("show");
  categoryDeleteLabel = null;
  categoryDeleteTargets = [];
  categoryDeleteSubmit.disabled = false;
}

document.getElementById("category-delete-close").addEventListener("click", closeCategoryDelete);
document.getElementById("category-delete-cancel").addEventListener("click", closeCategoryDelete);
modalCategoryDelete.addEventListener("click", (event) => { if (event.target === modalCategoryDelete) closeCategoryDelete(); });
document.getElementById("category-delete-submit").addEventListener("click", async () => {
  const label = categoryDeleteLabel;
  const targets = categoryDeleteTargets;
  if (!label) { closeCategoryDelete(); return; }
  if (!targets.length) {
    removeFromCategoryCatalog(label);
    categoryDraftLabels = categoryDraftLabels.filter((item) => categoryKey(item) !== categoryKey(label));
    closeCategoryDelete();
    toast(t("categories_deleted"), "success");
    renderCategoryEditor();
    return;
  }
  const key = categoryKey(label);
  const refreshDetails = currentDetailsId != null && targets.some((tor) => tor.id === currentDetailsId);
  try {
    await Promise.all(targets.map((tor) => rpc("torrent-set", {
      ids: [tor.id],
      labels: (tor.labels || []).filter((item) => isFocusLabel(item) || categoryKey(item) !== key),
    })));
    removeFromCategoryCatalog(label);
    categoryDraftLabels = categoryDraftLabels.filter((item) => categoryKey(item) !== key);
    closeCategoryDelete();
    toast(t("categories_deleted"), "success");
    await poll();
    renderCategoryEditor();
    if (refreshDetails) fetchDetails();
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
});

/* Remove confirmation: single flow, checkbox opts into deleting local data.
   Unchecked by default — removing a torrent only drops it from the list,
   the downloaded content stays on disk. */
const modalRemove = document.getElementById("modal-remove");
const removeMsgEl = document.getElementById("remove-msg");
const removeDataCheckbox = document.getElementById("remove-delete-data");
const removeWarningEl = document.getElementById("remove-warning");

function openRemoveConfirm(deleteDataDefault = false) {
  if (!selected.size) return;
  removeMsgEl.textContent = tf("remove_msg", selected.size);
  removeDataCheckbox.checked = deleteDataDefault;
  removeWarningEl.classList.toggle("show", deleteDataDefault);
  modalRemove.classList.add("show");
}
function closeRemoveConfirm() { modalRemove.classList.remove("show"); }

removeDataCheckbox.addEventListener("change", () => {
  removeWarningEl.classList.toggle("show", removeDataCheckbox.checked);
});
document.getElementById("remove-close").addEventListener("click", closeRemoveConfirm);
document.getElementById("remove-cancel").addEventListener("click", closeRemoveConfirm);
modalRemove.addEventListener("click", (e) => { if (e.target === modalRemove) closeRemoveConfirm(); });
document.getElementById("remove-submit").addEventListener("click", () => {
  const deleteData = removeDataCheckbox.checked;
  closeRemoveConfirm();
  act("torrent-remove", { "delete-local-data": deleteData });
});

/* ==========================================================================
   SORT / FILTER / SEARCH
   ========================================================================== */
function markSortIndicator() {
  document.querySelectorAll("th[data-sort]").forEach((h) => {
    const isPeersHeader = h.dataset.sort === "peers";
    const active = h.dataset.sort === sortKey || (isPeersHeader && sortKey === "seeds");
    h.classList.toggle("sorted", active);
    h.querySelector(".arrow").textContent = active ? (sortDir === 1 ? "↑" : "↓") : "";
    h.querySelectorAll("[data-peer-sort]").forEach((part) => {
      part.classList.toggle("active", isPeersHeader && part.dataset.peerSort === sortKey);
    });
  });
}

renderTableHeader();
renderColumnsMenu();

els.head.addEventListener("click", (event) => {
  if (event.target.closest(".column-resizer")) return;
  const header = event.target.closest("th[data-sort]");
  if (!header) return;
  const key = header.dataset.sort;
  if (key === "peers") {
    if (sortKey === "seeds") {
      if (sortDir === -1) sortDir = 1;
      else { sortKey = "peers"; sortDir = -1; }
    } else if (sortKey === "peers") {
      if (sortDir === -1) sortDir = 1;
      else { sortKey = "seeds"; sortDir = -1; }
    } else {
      sortKey = "seeds";
      sortDir = -1;
    }
  } else if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = 1; }
  markSortIndicator();
  renderTable();
});

els.head.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-column-resize]");
  if (!handle || event.button !== 0) return;
  const id = handle.dataset.columnResize;
  const column = TABLE_COLUMNS.find((item) => item.id === id);
  if (!column) return;
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = tableColumnWidth(column);
  document.body.classList.add("is-resizing-columns");

  const move = (moveEvent) => {
    const width = Math.max(column.minWidth, Math.round(startWidth + moveEvent.clientX - startX));
    tableColumns.widths[id] = width;
    const col = els.tableCols.querySelector(`[data-column-id="${id}"]`);
    if (col) col.style.width = width + "px";
    syncTableWidth();
  };
  const finish = () => {
    document.body.classList.remove("is-resizing-columns");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveTableColumns();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
});
window.addEventListener("resize", syncTableWidth);

columnsButton.addEventListener("click", () => {
  const willOpen = columnsMenu.hidden;
  columnsMenu.hidden = !willOpen;
  columnsButton.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) renderColumnsMenu();
});
columnsList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-column-toggle]");
  if (!input) return;
  const id = input.dataset.columnToggle;
  tableColumns.visible = tableColumns.visible.filter((columnId) => columnId !== id);
  if (input.checked) tableColumns.visible.push(id);
  applyTableColumns();
});
columnsList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-column-move]");
  if (!button) return;
  moveTableColumn(button.dataset.columnId, button.dataset.columnMove === "up" ? -1 : 1);
});
document.getElementById("columns-reset").addEventListener("click", () => {
  tableColumns = defaultTableColumns();
  applyTableColumns();
});
document.addEventListener("pointerdown", (event) => {
  if (!columnsMenu.hidden && !columnsControl.contains(event.target)) closeColumnsMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !columnsMenu.hidden) closeColumnsMenu();
});

document.getElementById("sidebar").addEventListener("click", (e) => {
  const item = e.target.closest(".sidebar-item[data-filter]");
  if (!item) return;
  document.querySelectorAll(".sidebar-item").forEach((i) => i.classList.remove("active"));
  item.classList.add("active");
  currentFilter = item.dataset.filter;
  currentLabelFilter = null;
  renderLabelFilters();
  renderTable();
});

document.getElementById("label-filters").addEventListener("click", (e) => {
  const item = e.target.closest(".label-filter");
  if (!item) return;
  currentLabelFilter = item.dataset.label;
  currentFilter = "all";
  document.querySelectorAll(".sidebar-item[data-filter]").forEach((el) => el.classList.toggle("active", el.dataset.filter === "all"));
  renderLabelFilters();
  renderTable();
});

document.getElementById("search").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderTable();
});

/* ==========================================================================
   CONTEXT MENU
   ========================================================================== */
const ctxMenu = document.getElementById("ctx-menu");

els.body.addEventListener("contextmenu", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  e.preventDefault();
  const id = Number(tr.dataset.id);
  if (!selected.has(id)) { selected = new Set([id]); renderTable(); }
  const x = Math.min(e.clientX, window.innerWidth - 210);
  const y = Math.min(e.clientY, window.innerHeight - 160);
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
  ctxMenu.classList.add("show");
});

document.addEventListener("click", () => ctxMenu.classList.remove("show"));

ctxMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item) return;
  const action = item.dataset.action;
  if (action === "details") openDetails(Array.from(selected)[0]);
  else if (action === "resume") act("torrent-start");
  else if (action === "pause") act("torrent-stop");
  else if (action === "remove") openRemoveConfirm(false);
  else if (action === "remove-data") openRemoveConfirm(true);
});

/* ==========================================================================
   ADD TORRENT MODAL
   ========================================================================== */
const modal = document.getElementById("modal-add");
const magnetInput = document.getElementById("magnet-input");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const fileList = document.getElementById("file-list");
let pendingFiles = [];

document.getElementById("btn-add").addEventListener("click", () => {
  magnetInput.value = "";
  fileInput.value = "";
  pendingFiles = [];
  fileList.innerHTML = "";
  document.getElementById("start-paused").checked = false;
  document.getElementById("add-labels").value = "";
  document.getElementById("add-download-dir").value = "";
  document.getElementById("add-ratio-enabled").checked = false;
  document.getElementById("add-ratio").value = "2";
  document.getElementById("add-ratio").disabled = true;
  switchTab("link");
  modal.classList.add("show");
  setTimeout(() => magnetInput.focus(), 50);
});
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
function closeModal() { modal.classList.remove("show"); }

document.querySelectorAll(".modal-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".modal-tab").forEach((tabEl) => tabEl.classList.toggle("active", tabEl.dataset.tab === name));
  document.querySelectorAll(".modal-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => addFiles(fileInput.files));

function addFiles(fileListObj) {
  for (const f of fileListObj) {
    if (!f.name.toLowerCase().endsWith(".torrent")) continue;
    if (f.size > 16 * 1024 * 1024) {
      toast(t("toast_file_too_large"), "error");
      continue;
    }
    pendingFiles.push(f);
  }
  renderFileList();
}
function renderFileList() {
  fileList.innerHTML = pendingFiles.map((f, i) =>
    `<div class="fitem"><span>${escapeHtml(f.name)}</span><span data-i="${i}" style="cursor:pointer;color:var(--text-faint)">✕</span></div>`
  ).join("");
  fileList.querySelectorAll("[data-i]").forEach((el) => {
    el.addEventListener("click", () => { pendingFiles.splice(Number(el.dataset.i), 1); renderFileList(); });
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function labelsFromInput(value) {
  return uniqueCategories(value.split(","));
}

document.getElementById("add-ratio-enabled").addEventListener("change", () => {
  document.getElementById("add-ratio").disabled = !document.getElementById("add-ratio-enabled").checked;
});

document.getElementById("modal-submit").addEventListener("click", async () => {
  const paused = document.getElementById("start-paused").checked;
  const labelsInput = document.getElementById("add-labels").value.trim();
  const labels = labelsFromInput(labelsInput);
  const downloadDir = document.getElementById("add-download-dir").value.trim();
  const ratioEnabled = document.getElementById("add-ratio-enabled").checked;
  const ratio = finiteNonNegative(document.getElementById("add-ratio").value);
  if (/[\r\n]/.test(labelsInput)) { toast(t("toast_invalid_category"), "error"); return; }
  if (downloadDir && !isSharePath(downloadDir)) { toast(t("toast_invalid_path"), "error"); return; }
  if (ratioEnabled && ratio == null) { toast(t("toast_invalid_settings"), "error"); return; }
  const submitBtn = document.getElementById("modal-submit");
  submitBtn.disabled = true;
  let added = 0, failed = 0;

  const activePane = document.querySelector(".modal-pane.active").dataset.pane;
  try {
    if (activePane === "link") {
      const lines = magnetInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const link of lines) {
        if (!isAllowedTorrentSource(link)) { failed++; continue; }
        try { await addTorrent({ filename: link }, { paused, labels, downloadDir, ratioEnabled, ratio }); added++; }
        catch (e) { failed++; }
      }
    } else {
      for (const f of pendingFiles) {
        try {
          const b64 = await fileToBase64(f);
          await addTorrent({ metainfo: b64 }, { paused, labels, downloadDir, ratioEnabled, ratio });
          added++;
        } catch (e) { failed++; }
      }
    }
  } finally {
    submitBtn.disabled = false;
  }

  if (added) toast(t("toast_added") + added, "success");
  if (failed) toast(t("toast_add_failed") + failed, "error");
  if (added) { closeModal(); poll(); }
});

async function addTorrent(source, options) {
  const args = { ...source, paused: options.paused };
  if (options.labels.length) args.labels = options.labels;
  if (options.downloadDir) args["download-dir"] = options.downloadDir;
  const result = await rpc("torrent-add", args);
  const id = result["torrent-added"] && result["torrent-added"].id;
  if (id && options.ratioEnabled) {
    await rpc("torrent-set", { ids: [id], seedRatioMode: 1, seedRatioLimit: options.ratio });
  }
  return result;
}

/* ==========================================================================
   WINDOW-WIDE TORRENT DROP
   ========================================================================== */
const globalDropzone = document.getElementById("global-dropzone");
let windowDragDepth = 0;

function hasDroppedFiles(event) {
  return event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
}

function isInsideAddModal(target) {
  return modal.classList.contains("show") && target.closest("#modal-add");
}

async function addDroppedTorrents(files) {
  let added = 0;
  let failed = 0;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".torrent")) continue;
    if (file.size > 16 * 1024 * 1024) {
      toast(t("toast_file_too_large"), "error");
      continue;
    }
    try {
      const metainfo = await fileToBase64(file);
      await addTorrent({ metainfo }, { paused: false, labels: [], downloadDir: "", ratioEnabled: false, ratio: null });
      added++;
    } catch (e) {
      failed++;
    }
  }
  if (added) { toast(t("toast_added") + added, "success"); poll(); }
  if (failed) toast(t("toast_add_failed") + failed, "error");
}

document.addEventListener("dragenter", (event) => {
  if (!hasDroppedFiles(event) || isInsideAddModal(event.target)) return;
  event.preventDefault();
  windowDragDepth++;
  globalDropzone.classList.add("show");
});
document.addEventListener("dragover", (event) => {
  if (!hasDroppedFiles(event) || isInsideAddModal(event.target)) return;
  event.preventDefault();
  globalDropzone.classList.add("show");
});
document.addEventListener("dragleave", (event) => {
  if (!hasDroppedFiles(event) || isInsideAddModal(event.target)) return;
  windowDragDepth = Math.max(0, windowDragDepth - 1);
  if (!windowDragDepth) globalDropzone.classList.remove("show");
});
document.addEventListener("drop", (event) => {
  if (!hasDroppedFiles(event) || isInsideAddModal(event.target)) return;
  event.preventDefault();
  windowDragDepth = 0;
  globalDropzone.classList.remove("show");
  addDroppedTorrents(Array.from(event.dataTransfer.files));
});

/* ==========================================================================
   DETAILS MODAL — general info + per-file priority
   ========================================================================== */
const modalDetails = document.getElementById("modal-details");
const detailsTitle = document.getElementById("details-title");
const detailsGeneralEl = document.getElementById("details-general");
const fileRowsEl = document.getElementById("file-rows");
const detailsFirstStatusEl = document.getElementById("details-first-status");
const detailsRefreshButton = document.getElementById("details-refresh");

const DETAIL_FIELDS = [
  "id", "name", "status", "totalSize", "downloadDir", "hashString",
  "addedDate", "doneDate", "comment", "creator", "dateCreated", "isPrivate",
  "pieceCount", "pieceSize", "error", "errorString", "percentDone",
  "downloadedEver", "uploadedEver", "uploadRatio", "trackerStats",
  "files", "fileStats", "labels", "seedRatioLimit", "seedRatioMode",
];
// File names and sizes are immutable, but fileStats changes while downloading.
// Keep requesting the latter so open Details panels remain live without
// rebuilding a potentially very large file list.
const DETAIL_LIVE_FIELDS = DETAIL_FIELDS.filter((field) => field !== "files");

let currentDetailsId = null;
let detailsTimer = null;
let currentDetailsFileCount = 0;
let currentDetailsLabels = [];
let currentDetailsFiles = [];
let detailsRenderGeneration = 0;
const FOCUS_LABEL_PREFIX = "__torrentstation_focus_";
const isFocusLabel = (label) => label.startsWith(FOCUS_LABEL_PREFIX);

function openDetails(id) {
  if (id == null) return;
  currentDetailsId = id;
  switchDetailsTab("files");
  modalDetails.classList.add("show");
  fetchDetails();
  if (detailsTimer) clearInterval(detailsTimer);
  // File lists may contain thousands of rows. Keep the header current, but
  // do not repeatedly download and rebuild that large list in the background.
  detailsTimer = setInterval(() => fetchDetails(false), 2000);
}

function closeDetails() {
  modalDetails.classList.remove("show");
  currentDetailsId = null;
  detailsRenderGeneration++;
  if (detailsTimer) clearInterval(detailsTimer);
  detailsTimer = null;
}

// `pointerdown` happens before a row's click handler opens the panel, so a
// double-click on a torrent still opens Details instead of closing it again.
document.addEventListener("pointerdown", (event) => {
  if (modalDetails.classList.contains("show") && !modalDetails.contains(event.target)) closeDetails();
});

async function fetchDetails(includeFiles = true) {
  if (currentDetailsId == null) return;
  const requestedId = currentDetailsId;
  try {
    const data = await rpc("torrent-get", { ids: [requestedId], fields: includeFiles ? DETAIL_FIELDS : DETAIL_LIVE_FIELDS });
    if (currentDetailsId !== requestedId) return;
    const tor = data.torrents[0];
    if (!tor) { closeDetails(); return; }
    if (includeFiles) currentDetailsFileCount = (tor.files || []).length;
    currentDetailsLabels = tor.labels || [];
    detailsTitle.textContent = tor.name;
    renderDetailsGeneral(tor);
    if (includeFiles) renderDetailsFiles(tor);
    else updateDetailsFiles(tor);
    renderDetailsFirstStatus(tor);
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
}

function focusedFileIndex() {
  const label = currentDetailsLabels.find(isFocusLabel);
  if (!label) return null;
  const index = Number(label.slice(FOCUS_LABEL_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function renderDetailsFirstStatus(tor) {
  const index = focusedFileIndex();
  const file = index == null ? null : currentDetailsFiles[index];
  if (!file) {
    detailsFirstStatusEl.hidden = true;
    detailsFirstStatusEl.textContent = "";
    return;
  }
  const stat = (tor.fileStats || [])[index] || { bytesCompleted: 0 };
  const pct = file.length ? Math.round((stat.bytesCompleted / file.length) * 100) : 0;
  detailsFirstStatusEl.hidden = false;
  detailsFirstStatusEl.innerHTML = `
    <span class="details-first-mark" aria-hidden="true"></span>
    <span class="details-first-copy">
      <strong class="details-first-title" title="${escapeHtml(file.name)}">${escapeHtml(tf("details_first_file", file.name, pct))}</strong>
      <span class="details-first-note">${escapeHtml(t("details_first_note"))}</span>
    </span>`;
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "—";
  const locale = currentLang === "ru" ? "ru-RU" : "en-US";
  return new Date(unixSeconds * 1000).toLocaleString(locale, {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function renderDetailsGeneral(tor) {
  const rows = [
    [t("d_status"), statusMeta(tor.status).label],
    [t("d_size"), fmtBytes(tor.totalSize)],
    [t("d_downloaded"), fmtBytes(tor.downloadedEver)],
    [t("d_uploaded"), fmtBytes(tor.uploadedEver)],
    [t("d_ratio"), fmtRatio(tor.uploadRatio)],
    [t("d_location"), tor.downloadDir],
    [t("d_hash"), tor.hashString, true],
    [t("d_added"), fmtDate(tor.addedDate)],
    [t("d_completed"), tor.doneDate ? fmtDate(tor.doneDate) : "—"],
    [t("d_pieces"), `${tor.pieceCount} × ${fmtBytes(tor.pieceSize)}`],
    [t("d_private"), tor.isPrivate ? t("yes") : t("no")],
    [t("d_creator"), tor.creator || "—"],
    [t("d_comment"), tor.comment || "—"],
  ];
  if (tor.error && tor.error !== 0) rows.splice(1, 0, [t("d_error"), tor.errorString || t("st_error")]);

  const dl = rows.map(([k, v, mono]) => {
    return `<dt>${escapeHtml(k)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHtml(String(v))}</dd>`;
  }).join("");

  const labels = (tor.labels || []).filter((label) => !isFocusLabel(label));
  const categoryValue = labels.length
    ? labels.map((label) => `<span class="label-chip">${escapeHtml(label)}</span>`).join("")
    : `<span class="detail-category-empty">${escapeHtml(t("sb_uncategorized"))}</span>`;
  const categoryRow = `
    <dt>${escapeHtml(t("add_category"))}</dt>
    <dd class="detail-category">
      <span class="detail-category-labels">${categoryValue}</span>
      <button type="button" class="detail-category-edit" data-action="edit-category">${escapeHtml(t("details_edit_category"))}</button>
    </dd>`;

  const trackers = (tor.trackerStats || []).map((ts) => `
    <div class="tracker-row">
      <span class="t-url">${escapeHtml(ts.announce)}</span>
      <span>${ts.seederCount >= 0 ? ts.seederCount : "—"} / ${ts.leecherCount >= 0 ? ts.leecherCount : "—"}</span>
    </div>`).join("") || `<div class="tracker-row"><span class="t-url">—</span></div>`;

  detailsGeneralEl.innerHTML = `
    <dl class="detail-grid">${dl}${categoryRow}</dl>
    <div class="detail-section-title">${escapeHtml(t("d_trackers_title"))}</div>
    ${trackers}`;
}

detailsGeneralEl.addEventListener("click", (event) => {
  if (event.target.closest("[data-action=\"edit-category\"]") && currentDetailsId != null) {
    openCategories([currentDetailsId]);
  }
});

function renderDetailsFiles(tor) {
  const files = tor.files || [];
  const stats = tor.fileStats || [];
  currentDetailsFiles = files;
  const generation = ++detailsRenderGeneration;
  let index = 0;
  fileRowsEl.textContent = "";

  function appendBatch() {
    if (generation !== detailsRenderGeneration) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + 100, files.length);
    for (; index < end; index++) {
      const f = files[index];
      const i = index;
    const st = stats[i] || { bytesCompleted: 0, wanted: true, priority: 0 };
    const pct = f.length ? Math.round((st.bytesCompleted / f.length) * 100) : 0;
    const value = filePriorityValue(i, st);
      const row = document.createElement("div");
      row.className = "file-row" + (!st.wanted ? " skipped" : "") + (focusedFileIndex() === i ? " is-first" : "");
      row.dataset.idx = i;
      row.innerHTML = `
        <div class="f-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="f-size">${fmtBytes(f.length)}</div>
        <div class="f-progress">
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%; --fill-c:var(--progress-amber)"></div><div class="progress-pct">${pct}%</div></div>
        </div>
        <select data-idx="${i}">
          <option value="skip"${value === "skip" ? " selected" : ""}>${escapeHtml(t("priority_skip"))}</option>
          <option value="low"${value === "low" ? " selected" : ""}>${escapeHtml(t("priority_low"))}</option>
          <option value="normal"${value === "normal" ? " selected" : ""}>${escapeHtml(t("priority_normal"))}</option>
          <option value="high"${value === "high" ? " selected" : ""}>${escapeHtml(t("priority_high"))}</option>
          <option value="first"${value === "first" ? " selected" : ""}>${escapeHtml(t("priority_first"))}</option>
        </select>
      `;
      fragment.appendChild(row);
    }
    fileRowsEl.appendChild(fragment);
    if (index < files.length) requestAnimationFrame(appendBatch);
  }
  appendBatch();
}

function filePriorityValue(index, stat) {
  const isFirst = currentDetailsLabels.includes(FOCUS_LABEL_PREFIX + index);
  return isFirst ? "first" : !stat.wanted ? "skip" : stat.priority === 1 ? "high" : stat.priority === -1 ? "low" : "normal";
}

function updateDetailsFiles(tor) {
  const stats = tor.fileStats || [];
  if (!currentDetailsFiles.length || !stats.length) return;

  // Update only elements already on screen. This preserves an open priority
  // dropdown and avoids recreating thousands of rows every five seconds.
  fileRowsEl.querySelectorAll(".file-row").forEach((row) => {
    const index = Number(row.dataset.idx);
    const file = currentDetailsFiles[index];
    const stat = stats[index] || { bytesCompleted: 0, wanted: true, priority: 0 };
    if (!file) return;

    const pct = file.length ? Math.round((stat.bytesCompleted / file.length) * 100) : 0;
    const fill = row.querySelector(".progress-fill");
    const label = row.querySelector(".progress-pct");
    if (fill) fill.style.width = pct + "%";
    if (label) label.textContent = pct + "%";
    row.classList.toggle("skipped", !stat.wanted);
    row.classList.toggle("is-first", focusedFileIndex() === index);

    const select = row.querySelector("select[data-idx]");
    const value = filePriorityValue(index, stat);
    if (select && document.activeElement !== select && select.value !== value) select.value = value;
  });
}

async function setFilePriority(idx, value) {
  if (currentDetailsId == null) return;
  if (value === "first") {
    const torrentId = currentDetailsId;
    const otherFiles = Array.from({ length: currentDetailsFileCount }, (_, i) => i).filter((i) => i !== idx);
    try {
      // Transmission 4 can acknowledge a combined torrent-set request while
      // applying only some fields. Send each Focus step independently and do
      // not leave a recovery marker behind until Skip is verified.
      await rpc("torrent-set", {
        ids: [torrentId],
        "files-wanted": [idx],
      });
      await rpc("torrent-set", {
        ids: [torrentId],
        "priority-high": [idx],
      });
      await rpc("torrent-set", {
        ids: [torrentId],
        "files-unwanted": otherFiles,
      });

      const checked = await rpc("torrent-get", { ids: [torrentId], fields: ["fileStats"] });
      const stats = checked.torrents[0]?.fileStats || [];
      const targetReady = stats[idx]?.wanted && stats[idx]?.priority === 1;
      const othersSkipped = otherFiles.every((fileIndex) => stats[fileIndex] && !stats[fileIndex].wanted);
      if (!targetReady || !othersSkipped) throw new Error(t("priority_first_verify_failed"));

      await rpc("torrent-set", {
        ids: [torrentId],
        labels: [...currentDetailsLabels.filter((label) => !isFocusLabel(label)), FOCUS_LABEL_PREFIX + idx],
      });
      toast(t("priority_first_active"), "success");
      fetchDetails();
    } catch (e) {
      toast(t("toast_error") + e.message, "error");
    }
    return;
  }
  const args = { ids: [currentDetailsId] };
  if (value === "skip") {
    args["files-unwanted"] = [idx];
  } else {
    args["files-wanted"] = [idx];
    args[value === "high" ? "priority-high" : value === "low" ? "priority-low" : "priority-normal"] = [idx];
  }
  try {
    await rpc("torrent-set", args);
    fetchDetails();
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
}

function switchDetailsTab(name) {
  modalDetails.querySelectorAll(".modal-tab").forEach((tabEl) => tabEl.classList.toggle("active", tabEl.dataset.dtab === name));
  modalDetails.querySelectorAll(".modal-pane").forEach((p) => p.classList.toggle("active", p.dataset.dpane === name));
}

modalDetails.querySelectorAll(".modal-tab").forEach((tabEl) => {
  tabEl.addEventListener("click", () => switchDetailsTab(tabEl.dataset.dtab));
});

document.getElementById("details-close").addEventListener("click", closeDetails);
detailsRefreshButton.addEventListener("click", async () => {
  if (currentDetailsId == null) return;
  detailsRefreshButton.disabled = true;
  detailsRefreshButton.classList.add("is-refreshing");
  await fetchDetails(true);
  detailsRefreshButton.classList.remove("is-refreshing");
  detailsRefreshButton.disabled = false;
});

fileRowsEl.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-idx]");
  if (!sel) return;
  setFilePriority(Number(sel.dataset.idx), sel.value);
});

/* ==========================================================================
   TOAST
   ========================================================================== */
function toast(msg, kind = "") {
  const wrap = document.getElementById("toast-wrap");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 3200);
}

/* ==========================================================================
   LANGUAGE SWITCH
   ========================================================================== */
document.getElementById("lang-select").addEventListener("change", (e) => setLang(e.target.value));

/* ==========================================================================
   HISTORY MODAL — reads the daemon-written history.jsonl (added/done events,
   logged server-side by transmission's script-torrent-added/-done hooks —
   works even if no browser tab was open when the event happened).
   ========================================================================== */
const modalHistory = document.getElementById("modal-history");
const historyListEl = document.getElementById("history-list");

async function openHistory() {
  modalHistory.classList.add("show");
  historyListEl.innerHTML = "";
  try {
    const res = await fetch("history.jsonl?_=" + Date.now());
    if (!res.ok) throw new Error("no history file yet");
    const text = await res.text();
    const entries = text.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();

    if (!entries.length) {
      historyListEl.innerHTML = `<div class="empty-state"><div class="t2">${escapeHtml(t("history_empty"))}</div></div>`;
      return;
    }

    historyListEl.innerHTML = entries.map((e) => `
      <div class="history-row">
        <span class="dot ${e.event === "done" ? "seed" : "down"}"></span>
        <span class="h-name" title="${escapeHtml(e.name || "?")}">${escapeHtml(e.name || "?")}</span>
        <span class="h-event">${e.event === "done" ? escapeHtml(t("history_done")) : escapeHtml(t("history_added"))}</span>
        <span class="h-time">${escapeHtml(fmtDate(e.ts))}</span>
      </div>`).join("");
  } catch (e) {
    historyListEl.innerHTML = `<div class="empty-state"><div class="t2">${escapeHtml(t("history_empty"))}</div></div>`;
  }
}

function closeHistory() { modalHistory.classList.remove("show"); }

document.getElementById("btn-history").addEventListener("click", openHistory);
document.getElementById("history-close").addEventListener("click", closeHistory);
modalHistory.addEventListener("click", (e) => { if (e.target === modalHistory) closeHistory(); });

/* ==========================================================================
   SETTINGS MODAL
   ========================================================================== */
const modalSettings = document.getElementById("modal-settings");

const SETTINGS_FIELDS = [
  "download-dir",
  "incomplete-dir", "incomplete-dir-enabled",
  "watch-dir", "watch-dir-enabled",
  "speed-limit-down", "speed-limit-down-enabled",
  "speed-limit-up", "speed-limit-up-enabled",
  "seedRatioLimit", "seedRatioLimited",
  "download-queue-enabled", "download-queue-size",
  "seed-queue-enabled", "seed-queue-size",
  "peer-port", "port-forwarding-enabled", "encryption",
];

function isSharePath(value) {
  return /^\/share(?:\/|$)/.test(value) && !/[\u0000\r\n]/.test(value);
}

function isAllowedTorrentSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === "magnet:" || url.protocol === "http:" || url.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function setNumInputEnabled(checkboxId, inputId) {
  document.getElementById(inputId).disabled = !document.getElementById(checkboxId).checked;
}

async function openSettings() {
  try {
    const s = await rpc("session-get", { fields: SETTINGS_FIELDS });
    document.getElementById("set-download-dir").value = s["download-dir"] || "";
    document.getElementById("set-incomplete-enabled").checked = !!s["incomplete-dir-enabled"];
    document.getElementById("set-incomplete-dir").value = s["incomplete-dir"] || "";
    document.getElementById("set-watch-enabled").checked = !!s["watch-dir-enabled"];
    document.getElementById("set-watch-dir").value = s["watch-dir"] || "";
    document.getElementById("set-dl-limit-enabled").checked = !!s["speed-limit-down-enabled"];
    document.getElementById("set-dl-limit").value = s["speed-limit-down"] ?? 0;
    document.getElementById("set-ul-limit-enabled").checked = !!s["speed-limit-up-enabled"];
    document.getElementById("set-ul-limit").value = s["speed-limit-up"] ?? 0;
    document.getElementById("set-ratio-enabled").checked = !!s["seedRatioLimited"];
    document.getElementById("set-ratio").value = s["seedRatioLimit"] ?? 2;
    document.getElementById("set-download-queue-enabled").checked = !!s["download-queue-enabled"];
    document.getElementById("set-download-queue-size").value = s["download-queue-size"] ?? 3;
    document.getElementById("set-seed-queue-enabled").checked = !!s["seed-queue-enabled"];
    document.getElementById("set-seed-queue-size").value = s["seed-queue-size"] ?? 5;
    document.getElementById("set-peer-port").value = s["peer-port"] ?? 51413;
    document.getElementById("set-portmap").checked = !!s["port-forwarding-enabled"];
    document.getElementById("set-encryption").value = s["encryption"] || "preferred";
    setNumInputEnabled("set-incomplete-enabled", "set-incomplete-dir");
    setNumInputEnabled("set-watch-enabled", "set-watch-dir");
    setNumInputEnabled("set-dl-limit-enabled", "set-dl-limit");
    setNumInputEnabled("set-ul-limit-enabled", "set-ul-limit");
    setNumInputEnabled("set-ratio-enabled", "set-ratio");
    setNumInputEnabled("set-download-queue-enabled", "set-download-queue-size");
    setNumInputEnabled("set-seed-queue-enabled", "set-seed-queue-size");
    modalSettings.classList.add("show");
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
}

function closeSettings() { modalSettings.classList.remove("show"); }

document.getElementById("btn-settings").addEventListener("click", openSettings);
document.getElementById("settings-close").addEventListener("click", closeSettings);
document.getElementById("settings-cancel").addEventListener("click", closeSettings);
modalSettings.addEventListener("click", (e) => { if (e.target === modalSettings) closeSettings(); });

document.getElementById("set-incomplete-enabled").addEventListener("change", () => setNumInputEnabled("set-incomplete-enabled", "set-incomplete-dir"));
document.getElementById("set-watch-enabled").addEventListener("change", () => setNumInputEnabled("set-watch-enabled", "set-watch-dir"));
document.getElementById("set-dl-limit-enabled").addEventListener("change", () => setNumInputEnabled("set-dl-limit-enabled", "set-dl-limit"));
document.getElementById("set-ul-limit-enabled").addEventListener("change", () => setNumInputEnabled("set-ul-limit-enabled", "set-ul-limit"));
document.getElementById("set-ratio-enabled").addEventListener("change", () => setNumInputEnabled("set-ratio-enabled", "set-ratio"));
document.getElementById("set-download-queue-enabled").addEventListener("change", () => setNumInputEnabled("set-download-queue-enabled", "set-download-queue-size"));
document.getElementById("set-seed-queue-enabled").addEventListener("change", () => setNumInputEnabled("set-seed-queue-enabled", "set-seed-queue-size"));

document.getElementById("settings-save").addEventListener("click", async () => {
  const downloadDir = document.getElementById("set-download-dir").value.trim();
  const incompleteDir = document.getElementById("set-incomplete-dir").value.trim();
  const watchDir = document.getElementById("set-watch-dir").value.trim();
  const incompleteEnabled = document.getElementById("set-incomplete-enabled").checked;
  const watchEnabled = document.getElementById("set-watch-enabled").checked;
  const dlLimit = finiteNonNegative(document.getElementById("set-dl-limit").value);
  const ulLimit = finiteNonNegative(document.getElementById("set-ul-limit").value);
  const ratioLimit = finiteNonNegative(document.getElementById("set-ratio").value);
  const downloadQueueSize = Number(document.getElementById("set-download-queue-size").value);
  const seedQueueSize = Number(document.getElementById("set-seed-queue-size").value);
  const peerPort = Number(document.getElementById("set-peer-port").value);

  if (!isSharePath(downloadDir)
      || (incompleteEnabled && !isSharePath(incompleteDir))
      || (watchEnabled && !isSharePath(watchDir))) {
    toast(t("toast_invalid_path"), "error");
    return;
  }
  if (dlLimit == null || ulLimit == null || ratioLimit == null
      || !Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) {
    toast(t("toast_invalid_settings"), "error");
    return;
  }
  if (!Number.isInteger(downloadQueueSize) || downloadQueueSize < 1 || downloadQueueSize > 100
      || !Number.isInteger(seedQueueSize) || seedQueueSize < 1 || seedQueueSize > 1000) {
    toast(t("toast_invalid_settings"), "error");
    return;
  }

  const args = {
    "download-dir": downloadDir,
    "incomplete-dir-enabled": incompleteEnabled,
    "incomplete-dir": incompleteDir,
    "watch-dir-enabled": watchEnabled,
    "watch-dir": watchDir,
    "speed-limit-down-enabled": document.getElementById("set-dl-limit-enabled").checked,
    "speed-limit-down": dlLimit,
    "speed-limit-up-enabled": document.getElementById("set-ul-limit-enabled").checked,
    "speed-limit-up": ulLimit,
    seedRatioLimited: document.getElementById("set-ratio-enabled").checked,
    seedRatioLimit: ratioLimit,
    "download-queue-enabled": document.getElementById("set-download-queue-enabled").checked,
    "download-queue-size": downloadQueueSize,
    "seed-queue-enabled": document.getElementById("set-seed-queue-enabled").checked,
    "seed-queue-size": seedQueueSize,
    "peer-port": peerPort,
    "port-forwarding-enabled": document.getElementById("set-portmap").checked,
    encryption: document.getElementById("set-encryption").value,
  };
  try {
    await rpc("session-set", args);
    downloadDirCache = downloadDir;
    refreshFreeSpace();
    closeSettings();
    toast(t("toast_done"), "success");
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
});

/* ==========================================================================
   FOLDER PICKER — breadcrumb browser for the download/incomplete/watch dir
   fields in Settings. Backed by a flat snapshot of real directories under
   /share (TorrentStation.sh regenerates it every start — see
   ensure_folders_snapshot), not a live listing: cheap, no extra backend,
   but a folder created on the NAS only shows up after the next restart.
   ========================================================================== */
const modalFolderPicker = document.getElementById("modal-folder-picker");
const FOLDER_ROOT = "/share";
let folderTree = [];
let folderPickerPath = FOLDER_ROOT;
let folderPickerTarget = null;

async function loadFolderTree() {
  try {
    const res = await fetch("folders.json?_=" + Date.now());
    if (!res.ok) return [];
    const tree = await res.json();
    return Array.isArray(tree)
      ? [...new Set(tree.filter((path) => typeof path === "string" && isSharePath(path)))].sort()
      : [];
  } catch (e) {
    return [];
  }
}

function folderChildren(path) {
  const prefix = path.endsWith("/") ? path : path + "/";
  return folderTree
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .sort((a, b) => a.localeCompare(b));
}

function renderFolderBreadcrumb(path) {
  const rel = path === FOLDER_ROOT ? "" : path.slice(FOLDER_ROOT.length);
  const parts = rel.split("/").filter(Boolean);
  let acc = FOLDER_ROOT;
  const crumbs = [{ label: "share", path: FOLDER_ROOT }];
  parts.forEach((part) => {
    acc += "/" + part;
    crumbs.push({ label: part, path: acc });
  });
  document.getElementById("folder-breadcrumb").innerHTML = crumbs
    .map((c, i) => {
      const sep = i < crumbs.length - 1 ? '<span class="crumb-sep">/</span>' : "";
      return `<span class="crumb" data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</span>${sep}`;
    })
    .join("");
}

function renderFolderList(path) {
  const children = folderChildren(path);
  const listEl = document.getElementById("folder-list");
  if (!children.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="t2">${escapeHtml(t("folder_picker_empty"))}</div></div>`;
    return;
  }
  listEl.innerHTML = children
    .map((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      return `<div class="folder-row" data-path="${escapeHtml(p)}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <span>${escapeHtml(name)}</span>
      </div>`;
    })
    .join("");
}

function goToFolder(path) {
  if (!isSharePath(path) || !folderTree.includes(path)) return;
  folderPickerPath = path;
  renderFolderBreadcrumb(path);
  renderFolderList(path);
}

async function openFolderPicker(inputId) {
  folderPickerTarget = inputId;
  const startVal = document.getElementById(inputId).value.trim();
  folderTree = await loadFolderTree();
  let start = FOLDER_ROOT;
  if (startVal) {
    if (folderTree.includes(startVal)) {
      start = startVal;
    } else {
      // walk up from the typed path to the nearest known ancestor
      let p = startVal.replace(/\/$/, "");
      while (p.includes("/")) {
        p = p.slice(0, p.lastIndexOf("/"));
        if (folderTree.includes(p)) { start = p; break; }
      }
    }
  }
  goToFolder(start);
  modalFolderPicker.classList.add("show");
}
function closeFolderPicker() { modalFolderPicker.classList.remove("show"); }

document.querySelectorAll(".browse-btn").forEach((btn) => {
  btn.addEventListener("click", () => openFolderPicker(btn.dataset.target));
});
document.getElementById("folder-picker-close").addEventListener("click", closeFolderPicker);
document.getElementById("folder-picker-cancel").addEventListener("click", closeFolderPicker);
modalFolderPicker.addEventListener("click", (e) => { if (e.target === modalFolderPicker) closeFolderPicker(); });
document.getElementById("folder-breadcrumb").addEventListener("click", (e) => {
  const crumb = e.target.closest(".crumb");
  if (crumb) goToFolder(crumb.dataset.path);
});
document.getElementById("folder-list").addEventListener("click", (e) => {
  const row = e.target.closest(".folder-row");
  if (row) goToFolder(row.dataset.path);
});
document.getElementById("folder-picker-select").addEventListener("click", () => {
  if (folderPickerTarget) document.getElementById(folderPickerTarget).value = folderPickerPath;
  closeFolderPicker();
});

/* ==========================================================================
   APP ENTRY — runs once everything above is defined
   ========================================================================== */
app.classList.add("active");
startPolling();

/* keyboard: Escape closes modal/menu, Delete removes selection */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeDetails(); closeSettings(); closeHistory(); closeRemoveConfirm(); closeCategories(); closeFolderPicker(); ctxMenu.classList.remove("show"); }
  if (e.key === "Delete" && selected.size && app.classList.contains("active") && !modal.classList.contains("show") && !modalDetails.classList.contains("show")) {
    openRemoveConfirm(false);
  }
});
