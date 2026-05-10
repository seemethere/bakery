export type ThemePreference = "system" | "workbench-dark" | "workbench-light";

export const THEME_STORAGE_KEY = "piWebThemePreference";

const themeMediaQuery = "(prefers-color-scheme: light)";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "workbench-dark" || value === "workbench-light";
}

export function storedThemePreference(): ThemePreference {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(value) ? value : "system";
}

function resolveThemePreference(preference: ThemePreference): "workbench-dark" | "workbench-light" {
  if (preference === "system") return window.matchMedia(themeMediaQuery).matches ? "workbench-light" : "workbench-dark";
  return preference;
}

export function applyThemePreference(preference: ThemePreference): void {
  const resolved = resolveThemePreference(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved === "workbench-light" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", resolved === "workbench-dark");
}

export function saveThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreference(preference);
}

export function installThemePreference(): void {
  applyThemePreference(storedThemePreference());
  window.matchMedia(themeMediaQuery).addEventListener("change", () => {
    if (storedThemePreference() === "system") applyThemePreference("system");
  });
}
