"use strict";

/* ==========================================================================
   I18N — static dictionary + tiny apply-to-DOM engine.
   Add a new language by adding a key to I18N and a button in the switcher.
   ========================================================================== */
const I18N = {
  ru: {
    tb_add: "Добавить",
    tb_start: "Старт",
    tb_pause: "Пауза",
    tb_remove: "Удалить",
    search_ph: "Поиск по имени…",

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
    col_added: "Добавлен",
    col_down: "Загрузка",
    col_up: "Отдача",
    col_eta: "Осталось",
    col_ratio: "Рейтинг",
    col_peers: "Сиды/Пиры",

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

    ctx_details: "Детали",
    ctx_start: "Старт",
    ctx_pause: "Пауза",
    ctx_remove: "Удалить из списка",
    ctx_remove_data: "Удалить с диска",

    details_title: "Детали торрента",
    details_tab_general: "Обзор",
    details_tab_files: "Файлы",
    d_status: "Статус",
    d_size: "Размер",
    d_downloaded: "Скачано",
    d_uploaded: "Отдано",
    d_ratio: "Рейтинг",
    d_location: "Папка",
    d_hash: "Хэш",
    d_added: "Добавлен",
    d_completed: "Завершён",
    d_pieces: "Части",
    d_private: "Приватный",
    d_creator: "Создатель",
    d_comment: "Комментарий",
    d_error: "Ошибка",
    d_trackers_title: "Трекеры (сиды / личи)",
    yes: "Да",
    no: "Нет",
    priority_skip: "Пропустить",
    priority_low: "Низкий",
    priority_normal: "Обычный",
    priority_high: "Высокий",

    theme_toggle: "Тема",
    settings_title: "Настройки",
    set_downloads: "Загрузка",
    set_download_dir: "Папка загрузки",
    set_speed: "Скорость",
    set_dl_limit: "Ограничить загрузку",
    set_ul_limit: "Ограничить отдачу",
    set_seeding: "Раздача",
    set_ratio_limit: "Остановить раздачу по рейтингу",
    set_network: "Сеть",
    set_peer_port: "Порт входящих соединений",
    set_portmap: "Автоматическая переадресация портов (UPnP/NAT-PMP)",
    set_encryption: "Шифрование соединений",
    enc_tolerated: "Не требуется",
    enc_preferred: "Предпочтительно",
    enc_required: "Обязательно",
    set_save: "Сохранить",

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
    toast_reauth: "Сессия истекла, обновляем страницу…",

    confirm_remove: (n) => `Удалить ${n} торрент(ов) из списка (файлы останутся на диске)?`,
    confirm_remove_data: (n) => `Удалить ${n} торрент(ов) вместе с файлами на диске? Это необратимо.`,

    unit_b: "Б", unit_kb: "КБ", unit_mb: "МБ", unit_gb: "ГБ", unit_tb: "ТБ",
    per_sec: "/с",
    kbps: "КБ/с",
    eta_inf: "∞", eta_dash: "—",
    eta_s: "с", eta_m: "м", eta_h: "ч", eta_d: "д",
    ratio_inf: "∞",
    just_now: "только что",
    ago_suffix: " назад",
  },

  en: {
    tb_add: "Add",
    tb_start: "Start",
    tb_pause: "Pause",
    tb_remove: "Remove",
    search_ph: "Search by name…",

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
    col_added: "Added",
    col_down: "Down",
    col_up: "Up",
    col_eta: "ETA",
    col_ratio: "Ratio",
    col_peers: "Seeds/Peers",

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

    ctx_details: "Details",
    ctx_start: "Start",
    ctx_pause: "Pause",
    ctx_remove: "Remove from list",
    ctx_remove_data: "Remove + delete data",

    details_title: "Torrent Details",
    details_tab_general: "General",
    details_tab_files: "Files",
    d_status: "Status",
    d_size: "Size",
    d_downloaded: "Downloaded",
    d_uploaded: "Uploaded",
    d_ratio: "Ratio",
    d_location: "Location",
    d_hash: "Hash",
    d_added: "Added",
    d_completed: "Completed",
    d_pieces: "Pieces",
    d_private: "Private",
    d_creator: "Creator",
    d_comment: "Comment",
    d_error: "Error",
    d_trackers_title: "Trackers (seeds / peers)",
    yes: "Yes",
    no: "No",
    priority_skip: "Skip",
    priority_low: "Low",
    priority_normal: "Normal",
    priority_high: "High",

    theme_toggle: "Theme",
    settings_title: "Settings",
    set_downloads: "Downloads",
    set_download_dir: "Download folder",
    set_speed: "Speed",
    set_dl_limit: "Limit download speed",
    set_ul_limit: "Limit upload speed",
    set_seeding: "Seeding",
    set_ratio_limit: "Stop seeding at ratio",
    set_network: "Network",
    set_peer_port: "Incoming peer port",
    set_portmap: "Automatic port forwarding (UPnP/NAT-PMP)",
    set_encryption: "Peer connection encryption",
    enc_tolerated: "Not required",
    enc_preferred: "Preferred",
    enc_required: "Required",
    set_save: "Save",

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
    toast_reauth: "Session expired, reloading…",

    confirm_remove: (n) => `Remove ${n} torrent(s) from the list (files stay on disk)?`,
    confirm_remove_data: (n) => `Remove ${n} torrent(s) AND delete their files from disk? This cannot be undone.`,

    unit_b: "B", unit_kb: "KB", unit_mb: "MB", unit_gb: "GB", unit_tb: "TB",
    per_sec: "/s",
    kbps: "KB/s",
    eta_inf: "∞", eta_dash: "—",
    eta_s: "s", eta_m: "m", eta_h: "h", eta_d: "d",
    ratio_inf: "∞",
    just_now: "just now",
    ago_suffix: " ago",
  },
};

// Display name for each language, shown in the dropdown. Add a language by
// adding a key to I18N above and a name here — the <select> builds itself.
const LANG_NAMES = {
  ru: "Русский",
  en: "English",
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
  const langSelect = document.getElementById("lang-select");
  if (langSelect) {
    if (langSelect.options.length !== Object.keys(I18N).length) {
      langSelect.innerHTML = Object.keys(I18N)
        .map((code) => `<option value="${code}">${LANG_NAMES[code] || code}</option>`)
        .join("");
    }
    langSelect.value = currentLang;
  }
}

function setLang(lang) {
  if (!I18N[lang] || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyStaticI18n();
  if (typeof onLangChanged === "function") onLangChanged();
}

document.addEventListener("DOMContentLoaded", applyStaticI18n);
