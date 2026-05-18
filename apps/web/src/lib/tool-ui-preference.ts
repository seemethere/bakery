import { useEffect, useState } from "react";

export type ToolUiPreference = "default" | "bash-card";

const TOOL_UI_STORAGE_KEY = "piWebToolUi";

function normalizeToolUiPreference(value: string | null | undefined): ToolUiPreference | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "default" || normalized === "off" || normalized === "false") return "default";
  if (normalized === "bash-card" || normalized === "bash") return "bash-card";
  return null;
}

function readStoredToolUiPreference(): ToolUiPreference {
  if (typeof window === "undefined") return "bash-card";
  try {
    return normalizeToolUiPreference(window.localStorage.getItem(TOOL_UI_STORAGE_KEY)) ?? "bash-card";
  } catch {
    return "bash-card";
  }
}

function readUrlToolUiPreference(): ToolUiPreference | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeToolUiPreference(new URLSearchParams(window.location.search).get("toolUi"));
  } catch {
    return null;
  }
}

function persistToolUiPreference(value: ToolUiPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOOL_UI_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures in private/locked-down browser contexts.
  }
}

export function useToolUiPreference(): ToolUiPreference {
  const [preference, setPreference] = useState<ToolUiPreference>(() => readUrlToolUiPreference() ?? readStoredToolUiPreference());

  useEffect(() => {
    const urlPreference = readUrlToolUiPreference();
    if (urlPreference) {
      persistToolUiPreference(urlPreference);
      setPreference(urlPreference);
      return;
    }
    setPreference(readStoredToolUiPreference());
  }, []);

  return preference;
}
