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
  });

  if (res.status === 409) {
    sessionId = res.headers.get("X-Transmission-Session-Id");
    if (!_retried) return rpc(method, args, true);
    throw new Error("CSRF handshake failed");
  }
  if (res.status === 401) {
    const err = new Error("unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) throw new Error("RPC HTTP " + res.status);

  const data = await res.json();
  if (data.result !== "success") throw new Error(data.result || "RPC error");
  return data.arguments;
}

/* ==========================================================================
   APP ENTRY
   ========================================================================== */
const app = document.getElementById("app");

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
let searchTerm = "";
let sortKey = "name";
let sortDir = 1;
let pollTimer = null;
let downloadDirCache = null;
let lastStats = null;
let lastFreeBytes = null;

const els = {
  body: document.getElementById("torrent-body"),
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
  "id", "name", "status", "percentDone", "rateDownload", "rateUpload",
  "eta", "uploadRatio", "peersConnected", "peersSendingToUs", "peersGettingFromUs",
  "totalSize", "sizeWhenDone", "isFinished", "error", "errorString", "downloadDir",
];

async function poll() {
  try {
    const [tArgs, stats] = await Promise.all([
      rpc("torrent-get", { fields: FIELDS }),
      rpc("session-stats"),
    ]);
    torrents = tArgs.torrents;
    setConn(true);
    renderStats(stats);
    renderSidebarCounts();
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
  setInterval(refreshFreeSpace, 15000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
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
    if (tor.percentDone >= 1) c.completed++;
    if (tor.error && tor.error !== 0) c.error++;
  }
  for (const k in c) {
    const el = document.getElementById("cnt-" + k);
    if (el) el.textContent = c[k];
  }
}

/* ==========================================================================
   RENDER: table
   ========================================================================== */
function matchesFilter(tor) {
  switch (currentFilter) {
    case "downloading": return tor.status === 4;
    case "seeding": return tor.status === 6;
    case "active": return tor.status === 4 || tor.status === 6;
    case "paused": return tor.status === 0;
    case "checking": return tor.status === 1 || tor.status === 2;
    case "completed": return tor.percentDone >= 1;
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
    progress: (tor) => tor.percentDone,
    status: (tor) => tor.status,
    down: (tor) => tor.rateDownload,
    up: (tor) => tor.rateUpload,
    eta: (tor) => (tor.eta < 0 ? Infinity : tor.eta),
    ratio: (tor) => tor.uploadRatio,
    peers: (tor) => tor.peersConnected,
  }[sortKey];
  list.sort((a, b) => {
    const av = keyFn(a), bv = keyFn(b);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return list;
}

function renderTable() {
  const list = sortedFiltered();
  els.empty.style.display = list.length ? "none" : "flex";

  // reconcile selection with still-present ids
  const presentIds = new Set(torrents.map((tor) => tor.id));
  for (const id of Array.from(selected)) if (!presentIds.has(id)) selected.delete(id);
  updateToolbarState();

  els.body.innerHTML = list.map(rowHtml).join("");
}

function rowHtml(tor) {
  const meta = statusMeta(tor.status);
  const isError = tor.error && tor.error !== 0;
  const pct = Math.round(tor.percentDone * 100);
  const fillColor = tor.status === 6 ? "var(--green)" : tor.status === 0 ? "var(--text-faint)" : "var(--amber)";
  const isSel = selected.has(tor.id) ? "selected" : "";
  const errBadge = isError ? ` title="${escapeHtml(tor.errorString || t("st_error"))}"` : "";
  return `
    <tr class="${isSel}" data-id="${tor.id}">
      <td class="name-cell"${errBadge}><div class="fname">${escapeHtml(tor.name)}</div></td>
      <td class="num">${fmtBytes(tor.totalSize)}</td>
      <td>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%; --fill-c:${fillColor}"></div>
          <div class="progress-pct">${pct}%</div>
        </div>
      </td>
      <td><span class="status-pill"><span class="dot ${isError ? "error" : meta.dot}"></span>${isError ? t("st_error") : meta.label}</span></td>
      <td class="num ${tor.rateDownload ? "rate-down" : "rate-zero"}">${tor.rateDownload ? fmtRate(tor.rateDownload) : "—"}</td>
      <td class="num ${tor.rateUpload ? "rate-up" : "rate-zero"}">${tor.rateUpload ? fmtRate(tor.rateUpload) : "—"}</td>
      <td class="num">${tor.status === 4 ? fmtEta(tor.eta) : "—"}</td>
      <td class="num">${fmtRatio(tor.uploadRatio)}</td>
      <td class="num">${tor.peersConnected}</td>
    </tr>`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ==========================================================================
   SELECTION
   ========================================================================== */
let lastClickedId = null;

els.body.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const list = sortedFiltered().map((tor) => tor.id);

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
  renderTable();
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
document.getElementById("btn-remove").addEventListener("click", () => confirmRemove(false));

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

function confirmRemove(deleteData) {
  if (!selected.size) return;
  const n = selected.size;
  const msg = deleteData ? tf("confirm_remove_data", n) : tf("confirm_remove", n);
  if (!confirm(msg)) return;
  act("torrent-remove", { "delete-local-data": deleteData });
}

/* ==========================================================================
   SORT / FILTER / SEARCH
   ========================================================================== */
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    document.querySelectorAll("th[data-sort]").forEach((h) => {
      h.classList.remove("sorted");
      h.querySelector(".arrow").textContent = "";
    });
    th.classList.add("sorted");
    th.querySelector(".arrow").textContent = sortDir === 1 ? "↑" : "↓";
    renderTable();
  });
});

document.getElementById("sidebar").addEventListener("click", (e) => {
  const item = e.target.closest(".sidebar-item[data-filter]");
  if (!item) return;
  document.querySelectorAll(".sidebar-item").forEach((i) => i.classList.remove("active"));
  item.classList.add("active");
  currentFilter = item.dataset.filter;
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
  else if (action === "remove") confirmRemove(false);
  else if (action === "remove-data") confirmRemove(true);
});

els.body.addEventListener("dblclick", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  openDetails(Number(tr.dataset.id));
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
  pendingFiles = [];
  fileList.innerHTML = "";
  document.getElementById("start-paused").checked = false;
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
    if (!f.name.endsWith(".torrent")) continue;
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

document.getElementById("modal-submit").addEventListener("click", async () => {
  const paused = document.getElementById("start-paused").checked;
  const submitBtn = document.getElementById("modal-submit");
  submitBtn.disabled = true;
  let added = 0, failed = 0;

  const activePane = document.querySelector(".modal-pane.active").dataset.pane;
  try {
    if (activePane === "link") {
      const lines = magnetInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const link of lines) {
        try { await rpc("torrent-add", { filename: link, paused }); added++; }
        catch (e) { failed++; }
      }
    } else {
      for (const f of pendingFiles) {
        try {
          const b64 = await fileToBase64(f);
          await rpc("torrent-add", { metainfo: b64, paused });
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

/* ==========================================================================
   DETAILS MODAL — general info + per-file priority
   ========================================================================== */
const modalDetails = document.getElementById("modal-details");
const detailsTitle = document.getElementById("details-title");
const detailsGeneralEl = document.getElementById("details-general");
const fileRowsEl = document.getElementById("file-rows");

const DETAIL_FIELDS = [
  "id", "name", "status", "totalSize", "downloadDir", "hashString",
  "addedDate", "doneDate", "comment", "creator", "dateCreated", "isPrivate",
  "pieceCount", "pieceSize", "error", "errorString", "percentDone",
  "downloadedEver", "uploadedEver", "uploadRatio", "trackerStats",
  "files", "fileStats",
];

let currentDetailsId = null;
let detailsTimer = null;

function openDetails(id) {
  if (id == null) return;
  currentDetailsId = id;
  switchDetailsTab("general");
  modalDetails.classList.add("show");
  fetchDetails();
  detailsTimer = setInterval(fetchDetails, 3000);
}

function closeDetails() {
  modalDetails.classList.remove("show");
  currentDetailsId = null;
  if (detailsTimer) clearInterval(detailsTimer);
  detailsTimer = null;
}

async function fetchDetails() {
  if (currentDetailsId == null) return;
  try {
    const data = await rpc("torrent-get", { ids: [currentDetailsId], fields: DETAIL_FIELDS });
    const tor = data.torrents[0];
    if (!tor) { closeDetails(); return; }
    detailsTitle.textContent = tor.name;
    renderDetailsGeneral(tor);
    renderDetailsFiles(tor);
  } catch (e) {
    toast(t("toast_error") + e.message, "error");
  }
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "—";
  const locale = currentLang === "ru" ? "ru-RU" : "en-US";
  return new Date(unixSeconds * 1000).toLocaleString(locale);
}

function renderDetailsGeneral(tor) {
  const rows = [
    [t("d_status"), statusMeta(tor.status).label],
    [t("d_size"), fmtBytes(tor.totalSize)],
    [t("d_downloaded"), fmtBytes(tor.downloadedEver)],
    [t("d_uploaded"), fmtBytes(tor.uploadedEver)],
    [t("d_ratio"), fmtRatio(tor.uploadRatio)],
    [t("d_location"), tor.downloadDir],
    [t("d_hash"), tor.hashString],
    [t("d_added"), fmtDate(tor.addedDate)],
    [t("d_completed"), tor.doneDate ? fmtDate(tor.doneDate) : "—"],
    [t("d_pieces"), `${tor.pieceCount} × ${fmtBytes(tor.pieceSize)}`],
    [t("d_private"), tor.isPrivate ? t("yes") : t("no")],
    [t("d_creator"), tor.creator || "—"],
    [t("d_comment"), tor.comment || "—"],
  ];
  if (tor.error && tor.error !== 0) rows.splice(1, 0, [t("d_error"), tor.errorString || t("st_error")]);

  const dl = rows.map(([k, v], i) => {
    const mono = i === 6; // hash
    return `<dt>${escapeHtml(k)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHtml(String(v))}</dd>`;
  }).join("");

  const trackers = (tor.trackerStats || []).map((ts) => `
    <div class="tracker-row">
      <span class="t-url">${escapeHtml(ts.announce)}</span>
      <span>${ts.seederCount >= 0 ? ts.seederCount : "—"} / ${ts.leecherCount >= 0 ? ts.leecherCount : "—"}</span>
    </div>`).join("") || `<div class="tracker-row"><span class="t-url">—</span></div>`;

  detailsGeneralEl.innerHTML = `
    <dl class="detail-grid">${dl}</dl>
    <div class="detail-section-title">${escapeHtml(t("d_trackers_title"))}</div>
    ${trackers}`;
}

function renderDetailsFiles(tor) {
  const files = tor.files || [];
  const stats = tor.fileStats || [];
  fileRowsEl.innerHTML = files.map((f, i) => {
    const st = stats[i] || { bytesCompleted: 0, wanted: true, priority: 0 };
    const pct = f.length ? Math.round((st.bytesCompleted / f.length) * 100) : 0;
    const value = !st.wanted ? "skip" : st.priority === 1 ? "high" : st.priority === -1 ? "low" : "normal";
    return `
      <div class="file-row${!st.wanted ? " skipped" : ""}" data-idx="${i}">
        <div class="f-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="f-size">${fmtBytes(f.length)}</div>
        <div class="f-progress">
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%; --fill-c:var(--amber)"></div><div class="progress-pct">${pct}%</div></div>
        </div>
        <select data-idx="${i}">
          <option value="skip"${value === "skip" ? " selected" : ""}>${escapeHtml(t("priority_skip"))}</option>
          <option value="low"${value === "low" ? " selected" : ""}>${escapeHtml(t("priority_low"))}</option>
          <option value="normal"${value === "normal" ? " selected" : ""}>${escapeHtml(t("priority_normal"))}</option>
          <option value="high"${value === "high" ? " selected" : ""}>${escapeHtml(t("priority_high"))}</option>
        </select>
      </div>`;
  }).join("");
}

async function setFilePriority(idx, value) {
  if (currentDetailsId == null) return;
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

async function setAllFiles(wanted) {
  if (currentDetailsId == null) return;
  const count = fileRowsEl.querySelectorAll(".file-row").length;
  const allIdx = Array.from({ length: count }, (_, i) => i);
  const args = { ids: [currentDetailsId] };
  args[wanted ? "files-wanted" : "files-unwanted"] = allIdx;
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
modalDetails.addEventListener("click", (e) => { if (e.target === modalDetails) closeDetails(); });

fileRowsEl.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-idx]");
  if (!sel) return;
  setFilePriority(Number(sel.dataset.idx), sel.value);
});

document.getElementById("files-select-all").addEventListener("click", () => setAllFiles(true));
document.getElementById("files-select-none").addEventListener("click", () => setAllFiles(false));

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
document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
});

/* ==========================================================================
   APP ENTRY — runs once everything above is defined
   ========================================================================== */
app.classList.add("active");
startPolling();

/* keyboard: Escape closes modal/menu, Delete removes selection */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeDetails(); ctxMenu.classList.remove("show"); }
  if (e.key === "Delete" && selected.size && app.classList.contains("active") && !modal.classList.contains("show") && !modalDetails.classList.contains("show")) {
    confirmRemove(false);
  }
});
