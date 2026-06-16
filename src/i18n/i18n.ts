/**
 * Promptuary i18n module
 *
 * Usage:
 *   import { t } from "../i18n/i18n";
 *   t("sidebar.mode.reading")               // → "阅读" / "Reading"
 *   t("notice.exportedTokens", { n: 1200 }) // → "已导出（约 1,200 tokens）"
 */

// ---------- locale imports ----------
import zhCN from "./locales/zh-CN";
import en from "./locales/en";

export type LocaleKey = keyof typeof zhCN;
export type Locale = "zh-CN" | "en";
export type LanguageSetting = "auto" | Locale;

const LOCALES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

let currentLocale: Locale = "zh-CN";

// ---------- public API ----------

/**
 * Translate a key with optional interpolation params.
 * Params use `{{name}}` syntax, e.g. t("key", { n: 5 }) → replaces {{n}} with "5"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let value = LOCALES[currentLocale]?.[key] ?? LOCALES["zh-CN"][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    }
  }
  return value;
}

/** Get current locale */
export function getLocale(): Locale {
  return currentLocale;
}

/** Set locale explicitly */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/**
 * Initialize i18n based on user setting.
 * - "auto": detect from localStorage / navigator.language
 * - explicit locale: use that
 */
export function initI18n(setting: LanguageSetting): void {
  if (setting !== "auto") {
    currentLocale = setting;
    return;
  }

  // 1. Try Obsidian's localStorage (Obsidian stores language preference)
  const obsidianLang = localStorage.getItem("language");
  if (obsidianLang) {
    currentLocale = obsidianLang.startsWith("zh") ? "zh-CN" : "en";
    return;
  }

  // 2. Try navigator.language
  const navLang = navigator.language;
  if (navLang) {
    currentLocale = navLang.startsWith("zh") ? "zh-CN" : "en";
    return;
  }

  // 3. Default to Chinese (primary audience)
  currentLocale = "zh-CN";
}
