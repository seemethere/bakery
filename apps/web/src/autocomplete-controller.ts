import type { CommandResponse, FileCompleteResponse, FileSearchResponse } from "@pi-web-agent/protocol";
import {
  closedCommandAutocompleteState,
  closedFileAutocompleteState,
  commandAutocompleteToken,
  fileAutocompleteToken,
  renderCommandAutocomplete,
  renderFileAutocomplete,
  type AutocompleteToken,
  type CommandAutocompleteState,
  type FileAutocompleteState,
} from "./autocomplete";

export type AutocompleteControllerOptions = {
  root: () => ParentNode;
  selectedSessionId: () => string | null;
  promptDraft: () => string;
  setPromptDraft: (value: string) => void;
  savePromptDraft: () => void;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  setNotice: (notice: string) => void;
  render: () => void;
  syncAutocompleteScroll: () => void;
};

export class AutocompleteController {
  private fileAutocomplete: FileAutocompleteState = closedFileAutocompleteState();
  private fileAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private fileAutocompleteRequest = 0;
  private commandAutocomplete: CommandAutocompleteState = closedCommandAutocompleteState();
  private commandAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private commandAutocompleteRequest = 0;

  constructor(private readonly options: AutocompleteControllerOptions) {}

  get file(): FileAutocompleteState {
    return this.fileAutocomplete;
  }

  get command(): CommandAutocompleteState {
    return this.commandAutocomplete;
  }

  get active(): boolean {
    return this.commandAutocomplete.active || this.fileAutocomplete.active;
  }

  getFileToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return fileAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  getCommandToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return commandAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  updateForInput(input: HTMLTextAreaElement): void {
    const commandToken = this.getCommandToken(input);
    if (commandToken) {
      this.updateCommand(input, commandToken);
      if (this.fileAutocomplete.active) {
        this.closeFile();
        this.options.render();
      }
      return;
    }

    const fileToken = this.getFileToken(input);
    if (fileToken) {
      this.updateFile(input, fileToken);
      if (this.commandAutocomplete.active) {
        this.closeCommand();
        this.options.render();
      }
      return;
    }

    const hadAutocomplete = this.active;
    this.closeCommand();
    this.closeFile();
    if (hadAutocomplete) this.options.render();
  }

  updateFile(input: HTMLTextAreaElement, knownToken?: AutocompleteToken): void {
    const token = knownToken ?? this.getFileToken(input);
    if (!token || !this.options.selectedSessionId()) {
      const wasActive = this.fileAutocomplete.active;
      this.closeFile();
      if (wasActive) this.options.render();
      return;
    }

    if (this.commandAutocomplete.active) this.closeCommand();
    const shouldRenderOpen = !this.fileAutocomplete.active;
    this.fileAutocomplete = { ...this.fileAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    if (shouldRenderOpen) this.options.render();
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    const requestId = ++this.fileAutocompleteRequest;
    this.fileAutocompleteTimer = setTimeout(() => void this.fetchFile(token, requestId), 120);
  }

  closeFile(): void {
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    this.fileAutocompleteRequest++;
    this.fileAutocomplete = closedFileAutocompleteState();
  }

  updateCommand(input: HTMLTextAreaElement, knownToken?: AutocompleteToken): void {
    const token = knownToken ?? this.getCommandToken(input);
    if (!token || !this.options.selectedSessionId()) {
      const wasActive = this.commandAutocomplete.active;
      this.closeCommand();
      if (wasActive) this.options.render();
      return;
    }

    if (this.fileAutocomplete.active) this.closeFile();
    const shouldRenderOpen = !this.commandAutocomplete.active;
    this.commandAutocomplete = { ...this.commandAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    if (shouldRenderOpen) this.options.render();
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    const requestId = ++this.commandAutocompleteRequest;
    this.commandAutocompleteTimer = setTimeout(() => void this.fetchCommand(token, requestId), 120);
  }

  closeCommand(): void {
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    this.commandAutocompleteRequest++;
    this.commandAutocomplete = closedCommandAutocompleteState();
  }

  chooseCommand(index = this.commandAutocomplete.selectedIndex): void {
    const input = this.options.root().querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.commandAutocomplete.commands[index];
    if (!input || !choice) return;
    const inserted = `/${choice.name}`;
    const promptDraft = this.options.promptDraft();
    const before = promptDraft.slice(0, this.commandAutocomplete.start);
    const after = promptDraft.slice(this.commandAutocomplete.end);
    this.options.setPromptDraft(`${before}${inserted} ${after}`);
    this.options.savePromptDraft();
    input.value = this.options.promptDraft();
    const cursor = before.length + inserted.length + 1;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    this.closeCommand();
    this.options.render();
  }

  chooseFile(index = this.fileAutocomplete.selectedIndex): void {
    const input = this.options.root().querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.fileAutocomplete.files[index];
    if (!input || !choice) return;
    const suffix = choice.type === "directory" && !choice.path.endsWith("/") ? "/" : "";
    const inserted = `@${choice.path}${suffix}`;
    const spacer = choice.type === "directory" ? "" : " ";
    const promptDraft = this.options.promptDraft();
    const before = promptDraft.slice(0, this.fileAutocomplete.start);
    const after = promptDraft.slice(this.fileAutocomplete.end);
    this.options.setPromptDraft(`${before}${inserted}${spacer}${after}`);
    this.options.savePromptDraft();
    input.value = this.options.promptDraft();
    const cursor = before.length + inserted.length + spacer.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (choice.type === "directory") this.updateFile(input);
    else {
      this.closeFile();
      this.options.render();
    }
  }

  patchSelection(kind: "command" | "file"): void {
    const selector = kind === "command" ? ".command-autocomplete" : ".file-autocomplete";
    const indexAttr = kind === "command" ? "commandIndex" : "fileIndex";
    const selectedIndex = kind === "command" ? this.commandAutocomplete.selectedIndex : this.fileAutocomplete.selectedIndex;
    const container = this.options.root().querySelector<HTMLElement>(selector);
    if (!container) return;
    container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.classList.toggle("selected", Number(button.dataset[indexAttr]) === selectedIndex);
    });
    this.options.syncAutocompleteScroll();
  }

  patchCommand(): void {
    const existing = this.options.root().querySelector<HTMLElement>(".command-autocomplete");
    if (!existing) {
      this.options.render();
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = renderCommandAutocomplete(this.commandAutocomplete);
    const next = template.content.firstElementChild;
    if (!next) {
      existing.remove();
      return;
    }
    existing.replaceWith(next);
    next.querySelectorAll<HTMLButtonElement>("[data-command-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseCommand(Number(button.dataset.commandIndex ?? "0")));
    });
    this.options.syncAutocompleteScroll();
  }

  patchFile(): void {
    const existing = this.options.root().querySelector<HTMLElement>(".file-autocomplete");
    if (!existing) {
      this.options.render();
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = renderFileAutocomplete(this.fileAutocomplete);
    const next = template.content.firstElementChild;
    if (!next) {
      existing.remove();
      return;
    }
    existing.replaceWith(next);
    next.querySelectorAll<HTMLButtonElement>("[data-file-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseFile(Number(button.dataset.fileIndex ?? "0")));
    });
    this.options.syncAutocompleteScroll();
  }

  private async fetchFile(token: AutocompleteToken, requestId: number): Promise<void> {
    const sessionId = this.options.selectedSessionId();
    if (!sessionId) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const pathLike = token.token.includes("/") || token.token.startsWith(".");
      const response = pathLike
        ? await this.options.api<FileCompleteResponse>(`/api/sessions/${sessionId}/files/complete?prefix=${encoded}&limit=20`)
        : await this.options.api<FileSearchResponse>(`/api/sessions/${sessionId}/files/search?q=${encoded}&limit=20`);
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        files: response.files,
        selectedIndex: 0,
        loading: false,
      };
      this.patchFile();
    } catch (error) {
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = { ...this.fileAutocomplete, loading: false, files: [] };
      this.options.setNotice(`File autocomplete failed: ${error instanceof Error ? error.message : String(error)}`);
      this.patchFile();
    }
  }

  private async fetchCommand(token: AutocompleteToken, requestId: number): Promise<void> {
    const sessionId = this.options.selectedSessionId();
    if (!sessionId) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const response = await this.options.api<CommandResponse>(`/api/sessions/${sessionId}/commands?q=${encoded}&limit=20`);
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        commands: response.commands,
        selectedIndex: 0,
        loading: false,
      };
      this.patchCommand();
    } catch (error) {
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = { ...this.commandAutocomplete, loading: false, commands: [] };
      this.options.setNotice(`Command autocomplete failed: ${error instanceof Error ? error.message : String(error)}`);
      this.patchCommand();
    }
  }
}
