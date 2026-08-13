"use strict";

/* ==========================================================================
   RPC CLIENT — talks to Transmission's JSON-RPC endpoint at /transmission/rpc
   Handles the X-Transmission-Session-Id CSRF handshake and HTTP Basic auth.
   ========================================================================== */
const RPC_URL = "transmission/rpc";
const AUTH_KEY = "tq_auth"; // sessionStorage: base64("user:pass")

let sessionId = null;

function authHeader() {
  const b64 = sessionStorage.getItem(AUTH_KEY);
  return b64 ? "Basic " + b64 : null;
}

async function rpc(method, args = {}, _retried = false) {
  const headers = { "Content-Type": "application/json" };
  const auth = authHeader();
  if (auth) headers["Authorization"] = auth;
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
   LOGIN
   ========================================================================== */
const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const app = document.getElementById("app");

async function tryLogin(user, pass) {
  sessionStorage.setItem(AUTH_KEY, btoa(user + ":" + pass));
  try {
    await rpc("session-get");
    enterApp();
  } catch (e) {
    sessionStorage.removeItem(AUTH_KEY);
    loginError.classList.add("show");
    document.getElementById("f-pass").value = "";
    document.getElementById("f-pass").focus();
  }
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  loginError.classList.remove("show");
  const user = document.getElementById("f-user").value.trim();
  const pass = document.getElementById("f-pass").value;
  if (!user || !pass) return;
  tryLogin(user, pass);
});

document.getElementById("btn-logout").addEventListener("click", () => {
  sessionStorage.removeItem(AUTH_KEY);
  stopPolling();
  app.classList.remove("active");
  loginScreen.style.display = "flex";
  document.getElementById("f-pass").value = "";
});

function enterApp() {
  loginScreen.style.display = "none";
  app.classList.add("active");
  startPolling();
}

// Auto-login if credentials already in this tab's session
if (sessionStorage.getItem(AUTH_KEY)) {
  rpc("session-get").then(enterApp).catch(() => sessionStorage.removeItem(AUTH_KEY));
}

/* ==========================================================================
   FORMATTERS
   ========================================================================== */
function fmtBytes(n) {
  if (n === 0 || n == null) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}
function fmtRate(n) {
  if (!n) return "0 Б/с";
  return fmtBytes(n) + "/с";
}
function fmtEta(s) {
  if (s === -1 || s == null) return "∞";
  if (s === -2) return "—";
  if (s < 60) return s + "с";
  if (s < 3600) return Math.floor(s / 60) + "м";
  if (s < 86400) return Math.floor(s / 3600) + "ч " + Math.floor((s % 3600) / 60) + "м";
  return Math.floor(s / 86400) + "д " + Math.floor((s % 86400) / 3600) + "ч";
}
function fmtRatio(r) {
  if (r === -1) return "∞";
  return r.toFixed(2);
}

/* status: 0=stopped 1=check-wait 2=checking 3=dl-wait 4=downloading 5=seed-wait 6=seeding */
const STATUS_META = {
  0: { label: "Пауза", dot: "paused" },
  1: { label: "Ожидает проверки", dot: "check" },
  2: { label: "Проверка", dot: "check" },
  3: { label: "Ожидает загрузки", dot: "down" },
  4: { label: "Загрузка", dot: "down" },
  5: { label: "Ожидает раздачи", dot: "seed" },
  6: { label: "Раздача", dot: "seed" },
};

function category(t) {
  if (t.error && t.error !== 0) return "error";
  if (t.status === 0) return "paused";
  if (t.status === 1 || t.status === 2) return "checking";
  if (t.percentDone >= 1 && (t.status === 0 || t.status === 6 || t.status === 5)) {
    // completed bucket is a superset check applied separately below
  }
  if (t.status === 4) return "downloading";
  if (t.status === 6) return "seeding";
  return "other";
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
      sessionStorage.removeItem(AUTH_KEY);
      stopPolling();
      app.classList.remove("active");
      loginScreen.style.display = "flex";
      return;
    }
    setConn(false);
  }
}

async function refreshFreeSpace() {
  if (!downloadDirCache) return;
  try {
    const r = await rpc("free-space", { path: downloadDirCache });
    els.freeSpace.querySelector(".count").textContent = fmtBytes(r["size-bytes"]);
  } catch (e) { /* ignore */ }
}

function setConn(ok) {
  els.connDot.style.background = ok ? "var(--green)" : "var(--red)";
  els.connText.textContent = ok ? "Подключено" : "Нет связи";
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
  els.statDown.textContent = fmtRate(stats.downloadSpeed);
  els.statUp.textContent = fmtRate(stats.uploadSpeed);
  els.statCount.textContent = stats.torrentCount;
}

function renderSidebarCounts() {
  const c = { all: torrents.length, downloading: 0, seeding: 0, active: 0, paused: 0, checking: 0, completed: 0, error: 0 };
  for (const t of torrents) {
    if (t.status === 4) c.downloading++;
    if (t.status === 6) c.seeding++;
    if (t.status === 4 || t.status === 6) c.active++;
    if (t.status === 0) c.paused++;
    if (t.status === 1 || t.status === 2) c.checking++;
    if (t.percentDone >= 1) c.completed++;
    if (t.error && t.error !== 0) c.error++;
  }
  for (const k in c) {
    const el = document.getElementById("cnt-" + k);
    if (el) el.textContent = c[k];
  }
}

/* ==========================================================================
   RENDER: table
   ========================================================================== */
function matchesFilter(t) {
  switch (currentFilter) {
    case "downloading": return t.status === 4;
    case "seeding": return t.status === 6;
    case "active": return t.status === 4 || t.status === 6;
    case "paused": return t.status === 0;
    case "checking": return t.status === 1 || t.status === 2;
    case "completed": return t.percentDone >= 1;
    case "error": return t.error && t.error !== 0;
    default: return true;
  }
}

function sortedFiltered() {
  let list = torrents.filter(matchesFilter);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter((t) => t.name.toLowerCase().includes(q));
  }
  const keyFn = {
    name: (t) => t.name.toLowerCase(),
    size: (t) => t.totalSize,
    progress: (t) => t.percentDone,
    status: (t) => t.status,
    down: (t) => t.rateDownload,
    up: (t) => t.rateUpload,
    eta: (t) => (t.eta < 0 ? Infinity : t.eta),
    ratio: (t) => t.uploadRatio,
    peers: (t) => t.peersConnected,
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
  const presentIds = new Set(torrents.map((t) => t.id));
  for (const id of Array.from(selected)) if (!presentIds.has(id)) selected.delete(id);
  updateToolbarState();

  els.body.innerHTML = list.map(rowHtml).join("");
}

function rowHtml(t) {
  const meta = STATUS_META[t.status] || { label: "?", dot: "paused" };
  const pct = Math.round(t.percentDone * 100);
  const fillColor = t.status === 6 ? "var(--green)" : t.status === 0 ? "var(--text-faint)" : "var(--amber)";
  const isSel = selected.has(t.id) ? "selected" : "";
  const errBadge = t.error && t.error !== 0 ? ` title="${escapeHtml(t.errorString || "Ошибка")}"` : "";
  return `
    <tr class="${isSel}" data-id="${t.id}">
      <td class="name-cell"${errBadge}><div class="fname">${escapeHtml(t.name)}</div></td>
      <td class="num">${fmtBytes(t.totalSize)}</td>
      <td>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%; --fill-c:${fillColor}"></div>
          <div class="progress-pct">${pct}%</div>
        </div>
      </td>
      <td><span class="status-pill"><span class="dot ${t.error && t.error !== 0 ? "error" : meta.dot}"></span>${t.error && t.error !== 0 ? "Ошибка" : meta.label}</span></td>
      <td class="num ${t.rateDownload ? "rate-down" : "rate-zero"}">${t.rateDownload ? fmtRate(t.rateDownload) : "—"}</td>
      <td class="num ${t.rateUpload ? "rate-up" : "rate-zero"}">${t.rateUpload ? fmtRate(t.rateUpload) : "—"}</td>
      <td class="num">${t.status === 4 ? fmtEta(t.eta) : "—"}</td>
      <td class="num">${fmtRatio(t.uploadRatio)}</td>
      <td class="num">${t.peersConnected}</td>
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
  const list = sortedFiltered().map((t) => t.id);

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
    toast(method === "torrent-start" ? "Запущено" : method === "torrent-stop" ? "Поставлено на паузу" : "Готово");
    poll();
  } catch (e) {
    toast("Ошибка: " + e.message, "error");
  }
}

function confirmRemove(deleteData) {
  if (!selected.size) return;
  const n = selected.size;
  const msg = deleteData
    ? `Удалить ${n} торрент(ов) вместе с файлами на диске? Это необратимо.`
    : `Удалить ${n} торрент(ов) из списка (файлы останутся на диске)?`;
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
  if (action === "resume") act("torrent-start");
  else if (action === "pause") act("torrent-stop");
  else if (action === "remove") confirmRemove(false);
  else if (action === "remove-data") confirmRemove(true);
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
  document.querySelectorAll(".modal-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
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

  if (added) toast(`Добавлено: ${added}`, "success");
  if (failed) toast(`Не удалось добавить: ${failed}`, "error");
  if (added) { closeModal(); poll(); }
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

/* keyboard: Escape closes modal/menu, Delete removes selection */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); ctxMenu.classList.remove("show"); }
  if (e.key === "Delete" && selected.size && app.classList.contains("active") && !modal.classList.contains("show")) {
    confirmRemove(false);
  }
});
