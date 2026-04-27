import type { CommandInfo, FileMatch } from "@pi-web-agent/protocol";
import { escapeHtml } from "./utils";

export type AutocompleteToken = {
  token: string;
  start: number;
  end: number;
};

export type FileAutocompleteState = {
  active: boolean;
  token: string;
  start: number;
  end: number;
  files: FileMatch[];
  selectedIndex: number;
  loading: boolean;
};

export type CommandAutocompleteState = {
  active: boolean;
  token: string;
  start: number;
  end: number;
  commands: CommandInfo[];
  selectedIndex: number;
  loading: boolean;
};

export const closedFileAutocompleteState = (): FileAutocompleteState => ({ active: false, token: "", start: 0, end: 0, files: [], selectedIndex: 0, loading: false });

export const closedCommandAutocompleteState = (): CommandAutocompleteState => ({ active: false, token: "", start: 0, end: 0, commands: [], selectedIndex: 0, loading: false });

export function fileAutocompleteToken(value: string, selectionStart = value.length): AutocompleteToken | null {
  const end = selectionStart;
  const beforeCursor = value.slice(0, end);
  const match = /(^|\s)@([^\s]*)$/.exec(beforeCursor);
  if (!match) return null;
  return { token: match[2] ?? "", start: end - (match[2]?.length ?? 0) - 1, end };
}

export function commandAutocompleteToken(value: string, selectionStart = value.length): AutocompleteToken | null {
  const end = selectionStart;
  const beforeCursor = value.slice(0, end);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const line = beforeCursor.slice(lineStart);
  const match = /^\/([^\s]*)$/.exec(line);
  if (!match) return null;
  return { token: match[1] ?? "", start: lineStart, end };
}

export function renderCommandAutocomplete(state: CommandAutocompleteState): string {
  if (!state.active) return "";
  const title = state.loading
    ? "Loading commands..."
    : state.commands.length === 0
      ? "No command matches"
      : "Slash commands";
  return `
      <div class="command-autocomplete" role="listbox" aria-label="Slash command autocomplete">
        <div class="file-autocomplete-title">${escapeHtml(title)} <kbd>Tab</kbd>/<kbd>Enter</kbd> to insert</div>
        ${state.commands.map((command, index) => `
          <button type="button" role="option" data-command-index="${index}" class="${index === state.selectedIndex ? "selected" : ""}">
            <span class="command-name">/${escapeHtml(command.name)}</span>
            <span class="command-meta">
              <strong>${escapeHtml(command.source)}${command.unsupported ? " · UI-only/unsupported" : ""}</strong>
              ${command.argumentHint ? `<em>${escapeHtml(command.argumentHint)}</em>` : ""}
              ${command.description ? `<small>${escapeHtml(command.description)}</small>` : ""}
            </span>
          </button>`).join("")}
      </div>`;
}

export function renderFileAutocomplete(state: FileAutocompleteState): string {
  if (!state.active) return "";
  const title = state.loading
    ? "Searching files..."
    : state.files.length === 0
      ? "No file matches"
      : "File matches";
  return `
      <div class="file-autocomplete" role="listbox" aria-label="File autocomplete">
        <div class="file-autocomplete-title">${escapeHtml(title)} <kbd>Tab</kbd>/<kbd>Enter</kbd> to insert</div>
        ${state.files.map((file, index) => `
          <button type="button" role="option" data-file-index="${index}" class="${index === state.selectedIndex ? "selected" : ""}">
            <span>${file.type === "directory" ? "📁" : "📄"}</span>
            <strong>${escapeHtml(file.path)}${file.type === "directory" && !file.path.endsWith("/") ? "/" : ""}</strong>
          </button>`).join("")}
      </div>`;
}
