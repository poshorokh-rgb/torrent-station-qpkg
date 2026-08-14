"use strict";

/* ==========================================================================
   I18N — static dictionary + tiny apply-to-DOM engine.
   Add a new language by adding a key to I18N and a button in the switcher.
   ========================================================================== */
const I18N = {
  ru: {
    login_sub: "Панель управления — вход",
    login_user: "Логин",
    login_pass: "Пароль",
    login_submit: "Войти",
    login_error: "Неверный логин или пароль",

    tb_add: "Добавить",
    tb_start: "Старт",
    tb_pause: "Пауза",
    tb_remove: "Удалить",
    search_ph: "Поиск по имени…",
    logout_title: "Выйти",

    sb_status: "Статус",
    sb_all: "Все",
    sb_downloading: "Загрузка",
    sb_seeding: "Раздача",
    sb_active: "Активные",
    sb_paused: "На паузе",
    sb_checking: "Проверка",
    sb_completed: "Завершено",
    sb_error: "Ошибки",
    sb_storage: "Хранилище",
    sb_free: "Свободно",

    col_name: "Имя",
    col_size: "Размер",
    col_progress: "Прогресс",
    col_status: "Статус",
    col_down: "↓ Скорость",
    col_up: "↑ Скорость",
    col_eta: "Осталось",
    col_ratio: "Рейтинг",
    col_peers: "Пиры",

    empty_t1: "Пусто",
    empty_t2: "Добавьте торрент по ссылке-magnet или .torrent-файлом",

    conn_ok: "Подключено",
    conn_bad: "Нет связи",
    stat_total: "Всего:",

    modal_title: "Добавить торрент",
    tab_link: "Ссылка / Magnet",
    tab_file: "Файл .torrent",
    magnet_ph: "magnet:?xt=urn:btih:…\nможно несколько ссылок, каждая с новой строки",
    dropzone: "Перетащите .torrent файл(ы) сюда<br>или нажмите, чтобы выбрать",
    start_paused: "Добавить на паузе",
    modal_cancel: "Отмена",
    modal_submit: "Добавить",

    ctx_start: "Старт",
    ctx_pause: "Пауза",
    ctx_remove: "Удалить из списка",
    ctx_remove_data: "Удалить с диска",

    st_paused: "Пауза",
    st_check_wait: "Ожидает проверки",
    st_checking: "Проверка",
    st_dl_wait: "Ожидает загрузки",
    st_downloading: "Загрузка",
    st_seed_wait: "Ожидает раздачи",
    st_seeding: "Раздача",
    st_error: "Ошибка",
    st_default_err: "Ошибка",

    toast_started: "Запущено",
    toast_paused: "Поставлено на паузу",
    toast_done: "Готово",
    toast_error: "Ошибка: ",
    toast_added: "Добавлено: ",
    toast_add_failed: "Не удалось добавить: ",

    confirm_remove: (n) => `Удалить ${n} торрент(ов) из списка (файлы останутся на диске)?`,
    confirm_remove_data: (n) => `Удалить ${n} торрент(ов) вместе с файлами на диске? Это необратимо.`,

    unit_b: "Б", unit_kb: "КБ", unit_mb: "МБ", unit_gb: "ГБ", unit_tb: "ТБ",
    per_sec: "/с",
    eta_inf: "∞", eta_dash: "—",
    eta_s: "с", eta_m: "м", eta_h: "ч", eta_d: "д",
    ratio_inf: "∞",
  },

  en: {
    login_sub: "Control Panel — Sign In",
    login_user: "Username",
    login_pass: "Password",
    login_submit: "Sign In",
    login_error: "Invalid username or password",

    tb_add: "Add",
    tb_start: "Start",
    tb_pause: "Pause",
    tb_remove: "Remove",
    search_ph: "Search by name…",
    logout_title: "Sign out",

    sb_status: "Status",
    sb_all: "All",
    sb_downloading: "Downloading",
    sb_seeding: "Seeding",
    sb_active: "Active",
    sb_paused: "Paused",
    sb_checking: "Checking",
    sb_completed: "Completed",
    sb_error: "Errors",
    sb_storage: "Storage",
    sb_free: "Free",

    col_name: "Name",
    col_size: "Size",
    col_progress: "Progress",
    col_status: "Status",
    col_down: "↓ Speed",
    col_up: "↑ Speed",
    col_eta: "ETA",
    col_ratio: "Ratio",
    col_peers: "Peers",

    empty_t1: "Empty",
    empty_t2: "Add a torrent via magnet link or a .torrent file",

    conn_ok: "Connected",
    conn_bad: "Disconnected",
    stat_total: "Total:",

    modal_title: "Add Torrent",
    tab_link: "Link / Magnet",
    tab_file: ".torrent File",
    magnet_ph: "magnet:?xt=urn:btih:…\nmultiple links allowed, one per line",
    dropzone: "Drop .torrent file(s) here<br>or click to browse",
    start_paused: "Add paused",
    modal_cancel: "Cancel",
    modal_submit: "Add",

    ctx_start: "Start",
    ctx_pause: "Pause",
    ctx_remove: "Remove from list",
    ctx_remove_data: "Remove + delete data",

    st_paused: "Paused",
    st_check_wait: "Queued for check",
    st_checking: "Checking",
    st_dl_wait: "Queued to download",
    st_downloading: "Downloading",
    st_seed_wait: "Queued to seed",
    st_seeding: "Seeding",
    st_error: "Error",
    st_default_err: "Error",

    toast_started: "Started",
    toast_paused: "Paused",
    toast_done: "Done",
    toast_error: "Error: ",
    toast_added: "Added: ",
    toast_add_failed: "Failed to add: ",

    confirm_remove: (n) => `Remove ${n} torrent(s) from the list (files stay on disk)?`,
    confirm_remove_data: (n) => `Remove ${n} torrent(s) AND delete their files from disk? This cannot be undone.`,

    unit_b: "B", unit_kb: "KB", unit_mb: "MB", unit_gb: "GB", unit_tb: "TB",
    per_sec: "/s",
    eta_inf: "∞", eta_dash: "—",
    eta_s: "s", eta_m: "m", eta_h: "h", eta_d: "d",
    ratio_inf: "∞",
  },
};

const LANG_KEY = "tq_lang";
function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && I18N[saved]) return saved;
  return (navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en";
}
let currentLang = detectLang();

function t(key) {
  const dict = I18N[currentLang] || I18N.en;
  return dict[key] !== undefined ? dict[key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
}
function tf(key, ...args) {
  const fn = (I18N[currentLang] || I18N.en)[key] || I18N.en[key];
  return typeof fn === "function" ? fn(...args) : key;
}

function applyStaticI18n() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll(".lang-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.lang === currentLang);
  });
}

function setLang(lang) {
  if (!I18N[lang] || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyStaticI18n();
  if (typeof onLangChanged === "function") onLangChanged();
}

document.addEventListener("DOMContentLoaded", applyStaticI18n);
