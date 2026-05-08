import { useState, useRef, useCallback } from "react";
import type { CommandInfo, FileMatch, CommandResponse, FileCompleteResponse, FileSearchResponse } from "@pi-web-agent/protocol";

// ---- Token detection -------------------------------------------------------

type AutocompleteToken = { token: string; start: number; end: number };

function fileAutocompleteToken(value: string, selectionStart: number): AutocompleteToken | null {
  const beforeCursor = value.slice(0, selectionStart);
  const match = /(^|\s)@([^\s]*)$/.exec(beforeCursor);
  if (!match) return null;
  return { token: match[2] ?? "", start: selectionStart - (match[2]?.length ?? 0) - 1, end: selectionStart };
}

function commandAutocompleteToken(value: string, selectionStart: number): AutocompleteToken | null {
  const beforeCursor = value.slice(0, selectionStart);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const line = beforeCursor.slice(lineStart);
  const match = /^\/([^\s]*)$/.exec(line);
  if (!match) return null;
  return { token: match[1] ?? "", start: lineStart, end: selectionStart };
}

// ---- State -----------------------------------------------------------------

export type AutocompleteItem =
  | { kind: "command"; data: CommandInfo }
  | { kind: "file"; data: FileMatch };

export type AutocompleteState = {
  type: "command" | "file";
  token: AutocompleteToken;
  items: AutocompleteItem[];
  selectedIndex: number;
  loading: boolean;
} | null;

// ---- Hook ------------------------------------------------------------------

export function useAutocomplete(
  sessionId: string | null,
  fetchJson: <T>(path: string) => Promise<T>,
) {
  const [state, setState] = useState<AutocompleteState>(null);

  const fileTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileReqRef = useRef(0);
  const commandReqRef = useRef(0);

  const close = useCallback(() => {
    clearTimeout(fileTimerRef.current);
    clearTimeout(commandTimerRef.current);
    fileReqRef.current++;
    commandReqRef.current++;
    setState(null);
  }, []);

  const fetchFile = useCallback(async (token: AutocompleteToken, reqId: number) => {
    if (!sessionId) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const pathLike = token.token.includes("/") || token.token.startsWith(".");
      const res = pathLike
        ? await fetchJson<FileCompleteResponse>(`/api/sessions/${sessionId}/files/complete?prefix=${encoded}&limit=20`)
        : await fetchJson<FileSearchResponse>(`/api/sessions/${sessionId}/files/search?q=${encoded}&limit=20`);
      if (reqId !== fileReqRef.current) return;
      setState((prev) => prev?.type === "file" ? {
        ...prev,
        items: res.files.map((f) => ({ kind: "file" as const, data: f })),
        selectedIndex: 0,
        loading: false,
      } : prev);
    } catch {
      if (reqId !== fileReqRef.current) return;
      setState((prev) => prev?.type === "file" ? { ...prev, loading: false } : prev);
    }
  }, [sessionId, fetchJson]);

  const fetchCommand = useCallback(async (token: AutocompleteToken, reqId: number) => {
    if (!sessionId) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const res = await fetchJson<CommandResponse>(`/api/sessions/${sessionId}/commands?q=${encoded}&limit=20`);
      if (reqId !== commandReqRef.current) return;
      setState((prev) => prev?.type === "command" ? {
        ...prev,
        items: res.commands.map((c) => ({ kind: "command" as const, data: c })),
        selectedIndex: 0,
        loading: false,
      } : prev);
    } catch {
      if (reqId !== commandReqRef.current) return;
      setState((prev) => prev?.type === "command" ? { ...prev, loading: false } : prev);
    }
  }, [sessionId, fetchJson]);

  const updateForInput = useCallback((draft: string, selectionStart: number) => {
    if (!sessionId) { close(); return; }

    const commandToken = commandAutocompleteToken(draft, selectionStart);
    if (commandToken) {
      clearTimeout(fileTimerRef.current);
      fileReqRef.current++;
      setState((prev) => ({
        type: "command",
        token: commandToken,
        items: prev?.type === "command" && prev.token.token === commandToken.token ? prev.items : [],
        selectedIndex: 0,
        loading: true,
      }));
      clearTimeout(commandTimerRef.current);
      const reqId = ++commandReqRef.current;
      commandTimerRef.current = setTimeout(() => void fetchCommand(commandToken, reqId), 120);
      return;
    }

    const fileToken = fileAutocompleteToken(draft, selectionStart);
    if (fileToken) {
      clearTimeout(commandTimerRef.current);
      commandReqRef.current++;
      setState((prev) => ({
        type: "file",
        token: fileToken,
        items: prev?.type === "file" && prev.token.token === fileToken.token ? prev.items : [],
        selectedIndex: 0,
        loading: true,
      }));
      clearTimeout(fileTimerRef.current);
      const reqId = ++fileReqRef.current;
      fileTimerRef.current = setTimeout(() => void fetchFile(fileToken, reqId), 120);
      return;
    }

    close();
  }, [sessionId, fetchCommand, fetchFile, close]);

  // Move selection up (-1) or down (+1). Returns true if consumed.
  const navigate = useCallback((direction: 1 | -1): boolean => {
    if (!state || state.items.length === 0) return false;
    setState((prev) => {
      if (!prev) return prev;
      const max = prev.items.length - 1;
      const next = Math.max(0, Math.min(max, prev.selectedIndex + direction));
      return next === prev.selectedIndex ? prev : { ...prev, selectedIndex: next };
    });
    return true;
  }, [state]);

  // Confirm current selection. Returns { newDraft, newCursor } or null.
  const confirm = useCallback((): { newDraft: string; newCursor: number } | null => {
    if (!state || state.items.length === 0) return null;
    const item = state.items[state.selectedIndex];
    if (!item) return null;

    return null; // sentinel — caller calls insert() directly
  }, [state]);

  // Insert item at given index into draft, returns new { draft, cursor } or null.
  const insertSelected = useCallback((draft: string, atIndex?: number): { draft: string; cursor: number } | null => {
    if (!state || state.items.length === 0) return null;
    const index = atIndex ?? state.selectedIndex;
    const item = state.items[index];
    if (!item) return null;

    const { start, end } = state.token;
    const before = draft.slice(0, start);
    const after = draft.slice(end);

    if (item.kind === "command") {
      const inserted = `/${item.data.name} `;
      return { draft: `${before}${inserted}${after}`, cursor: before.length + inserted.length };
    } else {
      const suffix = item.data.type === "directory" && !item.data.path.endsWith("/") ? "/" : "";
      const spacer = item.data.type === "directory" ? "" : " ";
      const inserted = `@${item.data.path}${suffix}`;
      return { draft: `${before}${inserted}${spacer}${after}`, cursor: before.length + inserted.length + spacer.length };
    }
  }, [state]);

  // After inserting a directory, re-trigger file autocomplete for the new prefix
  const shouldRefetchAfterInsert = useCallback((item: AutocompleteItem): boolean => {
    return item.kind === "file" && item.data.type === "directory";
  }, []);

  void confirm; // used via insertSelected

  return { state, updateForInput, navigate, insertSelected, shouldRefetchAfterInsert, close };
}
