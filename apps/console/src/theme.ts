export type ConsoleTheme = "light" | "dark";

const storageKey = "oao-console-theme";

export function readConsoleTheme(): ConsoleTheme {
  try {
    return window.localStorage.getItem(storageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function applyConsoleTheme(theme: ConsoleTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0b100d" : "#f8faf9");
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // The theme still applies when storage is unavailable.
  }
}
