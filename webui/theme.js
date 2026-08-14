"use strict";

/* ==========================================================================
   THEME — light/dark toggle.
   The actual data-theme attribute is applied *before* this file loads (see
   the inline script in index.html's <head>) so there's no flash of the
   wrong theme. This file just wires up the toggle button and keeps things
   in sync afterwards.
   ========================================================================== */
const THEME_KEY = "tq_theme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyThemeIcon() {
  const dark = currentTheme() === "dark";
  const iconDark = document.getElementById("theme-icon-dark");
  const iconLight = document.getElementById("theme-icon-light");
  if (iconDark) iconDark.style.display = dark ? "" : "none";
  if (iconLight) iconLight.style.display = dark ? "none" : "";
}

function setTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem(THEME_KEY, theme);
  applyThemeIcon();
}

function toggleTheme() {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

document.addEventListener("DOMContentLoaded", () => {
  applyThemeIcon();
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", toggleTheme);
});
