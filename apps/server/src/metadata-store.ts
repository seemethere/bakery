import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { AppSettings, AutoGenerateMetadataOverride, SessionIsolationKind, SessionKind, SummarySource, TitleSource, ToolPermissionMode, WebSession, Workspace } from "@pi-web-agent/protocol";

export type SessionPreferences = {
  webSessionId: string;
  toolPermissionMode: ToolPermissionMode | null;
  uiStateJson: string | null;
};

export type WebCommandResultRecord = {
  id: string;
  title: string;
  body: string;
  isError: boolean;
  data?: unknown;
  timestamp: string;
};

export type SubmittedPromptRecord = {
  id: string;
  text: string;
  kind: "prompt" | "ask";
  timestamp: string;
  reconciledAt: string | null;
  error: string | null;
};

type SubmittedPromptRow = {
  id: string;
  web_session_id: string;
  text: string;
  kind: "prompt" | "ask";
  timestamp: string;
  reconciled_at: string | null;
  error: string | null;
};

type WebCommandResultRow = {
  id: string;
  web_session_id: string;
  title: string;
  body: string;
  is_error: number;
  data_json: string | null;
  timestamp: string;
};

type WorkspaceRow = {
  path: string;
  label: string;
  created_at: string;
};

type SessionRow = {
  id: string;
  kind: SessionKind;
  cwd: string | null;
  pi_session_file: string;
  isolation_kind: SessionIsolationKind;
  source_cwd: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_commit: string | null;
  worktree_source_dirty: number;
  title: string | null;
  title_source: TitleSource;
  summary: string | null;
  summary_source: SummarySource;
  summary_updated_at: string | null;
  metadata_generation_count: number;
  metadata_last_generated_at: string | null;
  auto_generate_metadata_override: AutoGenerateMetadataOverride;
  pinned: number;
  created_at: string;
  last_opened_at: string;
};

function mapSession(row: SessionRow): WebSession {
  return {
    id: row.id,
    kind: row.kind,
    cwd: row.cwd,
    piSessionFile: row.pi_session_file,
    isolationKind: row.isolation_kind,
    sourceCwd: row.source_cwd,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    worktreeBaseCommit: row.worktree_base_commit,
    worktreeSourceDirty: Boolean(row.worktree_source_dirty),
    title: row.title,
    titleSource: row.title_source,
    summary: row.summary,
    summarySource: row.summary_source,
    summaryUpdatedAt: row.summary_updated_at,
    metadataGenerationCount: row.metadata_generation_count,
    metadataLastGeneratedAt: row.metadata_last_generated_at,
    autoGenerateMetadataOverride: row.auto_generate_metadata_override,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function cleanTitle(value: string): string {
  return value.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function firstUserPrompt(path: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join(" ");
    } catch {
      // Ignore malformed lines; session manager will surface real errors elsewhere.
    }
  }
  return null;
}

export class MetadataStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private hasColumn(table: string, column: string): boolean {
    return this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  }

  private addColumn(table: string, sql: string, column: string): void {
    if (!this.hasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        pi_session_file TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_preferences (
        web_session_id TEXT PRIMARY KEY,
        tool_permission_mode TEXT,
        ui_state_json TEXT,
        FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS web_command_results (
        id TEXT PRIMARY KEY,
        web_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        data_json TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS web_submitted_prompts (
        id TEXT PRIMARY KEY,
        web_session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reconciled_at TEXT,
        error TEXT,
        FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        path TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.addColumn("web_sessions", "isolation_kind TEXT NOT NULL DEFAULT 'none'", "isolation_kind");
    this.addColumn("web_sessions", "source_cwd TEXT", "source_cwd");
    this.addColumn("web_sessions", "worktree_path TEXT", "worktree_path");
    this.addColumn("web_sessions", "worktree_branch TEXT", "worktree_branch");
    this.addColumn("web_sessions", "worktree_base_commit TEXT", "worktree_base_commit");
    this.addColumn("web_sessions", "worktree_source_dirty INTEGER NOT NULL DEFAULT 0", "worktree_source_dirty");
    this.addColumn("web_sessions", "title_source TEXT NOT NULL DEFAULT 'unset'", "title_source");
    this.addColumn("web_sessions", "summary TEXT", "summary");
    this.addColumn("web_sessions", "summary_source TEXT NOT NULL DEFAULT 'unset'", "summary_source");
    this.addColumn("web_sessions", "summary_updated_at TEXT", "summary_updated_at");
    this.addColumn("web_sessions", "metadata_generation_count INTEGER NOT NULL DEFAULT 0", "metadata_generation_count");
    this.addColumn("web_sessions", "metadata_last_generated_at TEXT", "metadata_last_generated_at");
    this.addColumn("web_sessions", "auto_generate_metadata_override TEXT NOT NULL DEFAULT 'default'", "auto_generate_metadata_override");
    this.addColumn("web_sessions", "pinned INTEGER NOT NULL DEFAULT 0", "pinned");
    this.addColumn("web_sessions", "kind TEXT NOT NULL DEFAULT 'workspace'", "kind");
    this.addColumn("web_submitted_prompts", "error TEXT", "error");
    this.relaxCwdNotNull();
    this.inferExistingTitleSources();
  }

  private relaxCwdNotNull(): void {
    const cwdInfo = this.db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(web_sessions)").all().find((row) => row.name === "cwd");
    if (!cwdInfo || cwdInfo.notnull === 0) return;
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE web_sessions_new (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            pi_session_file TEXT NOT NULL,
            title TEXT,
            created_at TEXT NOT NULL,
            last_opened_at TEXT NOT NULL,
            isolation_kind TEXT NOT NULL DEFAULT 'none',
            source_cwd TEXT,
            worktree_path TEXT,
            worktree_branch TEXT,
            worktree_base_commit TEXT,
            worktree_source_dirty INTEGER NOT NULL DEFAULT 0,
            title_source TEXT NOT NULL DEFAULT 'unset',
            summary TEXT,
            summary_source TEXT NOT NULL DEFAULT 'unset',
            summary_updated_at TEXT,
            metadata_generation_count INTEGER NOT NULL DEFAULT 0,
            metadata_last_generated_at TEXT,
            auto_generate_metadata_override TEXT NOT NULL DEFAULT 'default',
            pinned INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'workspace'
          );
          INSERT INTO web_sessions_new (id, cwd, pi_session_file, title, created_at, last_opened_at, isolation_kind, source_cwd, worktree_path, worktree_branch, worktree_base_commit, worktree_source_dirty, title_source, summary, summary_source, summary_updated_at, metadata_generation_count, metadata_last_generated_at, auto_generate_metadata_override, pinned, kind)
            SELECT id, cwd, pi_session_file, title, created_at, last_opened_at, isolation_kind, source_cwd, worktree_path, worktree_branch, worktree_base_commit, worktree_source_dirty, title_source, summary, summary_source, summary_updated_at, metadata_generation_count, metadata_last_generated_at, auto_generate_metadata_override, pinned, kind FROM web_sessions;
          DROP TABLE web_sessions;
          ALTER TABLE web_sessions_new RENAME TO web_sessions;
        `);
      })();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private inferExistingTitleSources(): void {
    const rows = this.db.query<SessionRow, []>("SELECT * FROM web_sessions WHERE title_source = 'unset' AND title IS NOT NULL").all();
    const update = this.db.query("UPDATE web_sessions SET title_source = ? WHERE id = ?");
    for (const row of rows) {
      const first = firstUserPrompt(row.pi_session_file);
      const inferred: TitleSource = first && row.title === cleanTitle(first) ? "first_prompt" : "manual";
      update.run(inferred, row.id);
    }
  }

  listWorkspaces(): Workspace[] {
    return this.db
      .query<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY label COLLATE NOCASE ASC, path ASC")
      .all()
      .map((row) => ({ path: row.path, label: row.label }));
  }

  addWorkspace(workspace: Workspace): Workspace {
    this.db
      .query("INSERT INTO workspaces (path, label, created_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET label = excluded.label")
      .run(workspace.path, workspace.label, new Date().toISOString());
    return workspace;
  }

  deleteWorkspace(path: string): boolean {
    const result = this.db.query("DELETE FROM workspaces WHERE path = ?").run(path);
    return result.changes > 0;
  }

  listSessions(): WebSession[] {
    const rows = this.db
      .query<SessionRow, []>("SELECT * FROM web_sessions ORDER BY last_opened_at DESC")
      .all();
    return rows.map(mapSession);
  }

  getSession(id: string): WebSession | undefined {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM web_sessions WHERE id = ?").get(id);
    return row ? mapSession(row) : undefined;
  }

  createSession(input: { id: string; cwd: string | null; piSessionFile: string; kind?: SessionKind; title?: string | null; titleSource?: TitleSource; summary?: string | null; summarySource?: SummarySource; isolationKind?: SessionIsolationKind; sourceCwd?: string | null; worktreePath?: string | null; worktreeBranch?: string | null; worktreeBaseCommit?: string | null; worktreeSourceDirty?: boolean }): WebSession {
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO web_sessions (id, cwd, pi_session_file, kind, isolation_kind, source_cwd, worktree_path, worktree_branch, worktree_base_commit, worktree_source_dirty, title, title_source, summary, summary_source, summary_updated_at, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.cwd, input.piSessionFile, input.kind ?? "workspace", input.isolationKind ?? "none", input.sourceCwd ?? null, input.worktreePath ?? null, input.worktreeBranch ?? null, input.worktreeBaseCommit ?? null, input.worktreeSourceDirty ? 1 : 0, input.title ?? null, input.titleSource ?? (input.title ? "manual" : "unset"), input.summary ?? null, input.summarySource ?? (input.summary ? "derived" : "unset"), input.summary ? now : null, now, now);
    this.db.query("INSERT INTO session_preferences (web_session_id) VALUES (?)").run(input.id);
    const session = this.getSession(input.id);
    if (!session) throw new Error("Failed to create session");
    return session;
  }

  touchSession(id: string): void {
    this.db.query("UPDATE web_sessions SET last_opened_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  updateSession(id: string, input: { title?: string | null; titleSource?: TitleSource; summary?: string | null; summarySource?: SummarySource; autoGenerateMetadataOverride?: AutoGenerateMetadataOverride; pinned?: boolean; incrementGenerationCount?: boolean }): WebSession | undefined {
    const now = new Date().toISOString();
    if (Object.hasOwn(input, "title")) {
      this.db.query("UPDATE web_sessions SET title = ?, title_source = ? WHERE id = ?").run(input.title ?? null, input.titleSource ?? (input.title ? "manual" : "unset"), id);
    }
    if (Object.hasOwn(input, "summary")) {
      this.db.query("UPDATE web_sessions SET summary = ?, summary_source = ?, summary_updated_at = ? WHERE id = ?").run(input.summary ?? null, input.summarySource ?? (input.summary ? "manual" : "unset"), input.summary ? now : null, id);
    }
    if (input.autoGenerateMetadataOverride) {
      this.db.query("UPDATE web_sessions SET auto_generate_metadata_override = ? WHERE id = ?").run(input.autoGenerateMetadataOverride, id);
    }
    if (Object.hasOwn(input, "pinned")) {
      this.db.query("UPDATE web_sessions SET pinned = ? WHERE id = ?").run(input.pinned ? 1 : 0, id);
    }
    if (input.incrementGenerationCount) {
      this.db.query("UPDATE web_sessions SET metadata_generation_count = metadata_generation_count + 1, metadata_last_generated_at = ? WHERE id = ?").run(now, id);
    }
    return this.getSession(id);
  }

  attachWorkspace(id: string, cwd: string): WebSession | undefined {
    this.db.query("UPDATE web_sessions SET cwd = ?, kind = 'workspace' WHERE id = ?").run(cwd, id);
    return this.getSession(id);
  }

  setKind(id: string, kind: SessionKind): WebSession | undefined {
    this.db.query("UPDATE web_sessions SET kind = ? WHERE id = ?").run(kind, id);
    return this.getSession(id);
  }

  updatePreferences(id: string, input: { toolPermissionMode?: ToolPermissionMode; uiStateJson?: string }): void {
    this.db
      .query(
        `INSERT INTO session_preferences (web_session_id, tool_permission_mode, ui_state_json)
         VALUES (?, ?, ?)
         ON CONFLICT(web_session_id) DO UPDATE SET
           tool_permission_mode = COALESCE(excluded.tool_permission_mode, session_preferences.tool_permission_mode),
           ui_state_json = COALESCE(excluded.ui_state_json, session_preferences.ui_state_json)`,
      )
      .run(id, input.toolPermissionMode ?? null, input.uiStateJson ?? null);
  }

  addWebCommandResult(sessionId: string, input: { id?: string; title: string; body: string; isError?: boolean; data?: unknown; timestamp?: string }): WebCommandResultRecord {
    const record: WebCommandResultRecord = {
      id: input.id ?? `command:${crypto.randomUUID()}`,
      title: input.title,
      body: input.body,
      isError: Boolean(input.isError),
      ...(input.data !== undefined ? { data: input.data } : {}),
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.db
      .query("INSERT OR REPLACE INTO web_command_results (id, web_session_id, title, body, is_error, data_json, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, sessionId, record.title, record.body, record.isError ? 1 : 0, record.data === undefined ? null : JSON.stringify(record.data), record.timestamp);
    return record;
  }

  listWebCommandResults(sessionId: string): WebCommandResultRecord[] {
    return this.db
      .query<WebCommandResultRow, [string]>("SELECT * FROM web_command_results WHERE web_session_id = ? ORDER BY timestamp ASC, id ASC")
      .all(sessionId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        isError: Boolean(row.is_error),
        ...(row.data_json ? { data: JSON.parse(row.data_json) as unknown } : {}),
        timestamp: row.timestamp,
      }));
  }

  addSubmittedPrompt(sessionId: string, input: { id?: string; text: string; kind: "prompt" | "ask"; timestamp?: string }): SubmittedPromptRecord {
    const record: SubmittedPromptRecord = {
      id: input.id ?? `prompt:${crypto.randomUUID()}`,
      text: input.text,
      kind: input.kind,
      timestamp: input.timestamp ?? new Date().toISOString(),
      reconciledAt: null,
      error: null,
    };
    this.db
      .query("INSERT OR REPLACE INTO web_submitted_prompts (id, web_session_id, text, kind, timestamp, reconciled_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, sessionId, record.text, record.kind, record.timestamp, record.reconciledAt, record.error);
    return record;
  }

  markSubmittedPromptReconciled(sessionId: string, id: string, timestamp = new Date().toISOString()): SubmittedPromptRecord | undefined {
    const row = this.db.query<SubmittedPromptRow, [string, string]>("SELECT * FROM web_submitted_prompts WHERE web_session_id = ? AND id = ? AND reconciled_at IS NULL").get(sessionId, id);
    if (!row) return undefined;
    this.db.query("UPDATE web_submitted_prompts SET reconciled_at = ?, error = NULL WHERE id = ?").run(timestamp, row.id);
    return this.mapSubmittedPrompt(row, timestamp, null);
  }

  markSubmittedPromptError(sessionId: string, id: string, error: string): SubmittedPromptRecord | undefined {
    const timestamp = new Date().toISOString();
    this.db.query("UPDATE web_submitted_prompts SET error = ? WHERE web_session_id = ? AND id = ? AND reconciled_at IS NULL").run(error, sessionId, id);
    const row = this.db.query<SubmittedPromptRow, [string, string]>("SELECT * FROM web_submitted_prompts WHERE web_session_id = ? AND id = ?").get(sessionId, id);
    return row ? this.mapSubmittedPrompt(row, row.reconciled_at, error) : undefined;
  }

  listUnreconciledSubmittedPrompts(sessionId: string): SubmittedPromptRecord[] {
    return this.db
      .query<SubmittedPromptRow, [string]>("SELECT * FROM web_submitted_prompts WHERE web_session_id = ? AND reconciled_at IS NULL ORDER BY timestamp ASC, id ASC")
      .all(sessionId)
      .map((row) => this.mapSubmittedPrompt(row));
  }

  private mapSubmittedPrompt(row: SubmittedPromptRow, reconciledAt = row.reconciled_at, error = row.error): SubmittedPromptRecord {
    return {
      id: row.id,
      text: row.text,
      kind: row.kind,
      timestamp: row.timestamp,
      reconciledAt,
      error,
    };
  }

  getSettings(): AppSettings {
    const get = (key: string) => this.db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;
    const model = get("sessionMetadataModel");
    const defaultSessionModel = get("defaultSessionModel");
    return {
      autoGenerateSessionMetadata: get("autoGenerateSessionMetadata") !== "false",
      sessionMetadataModel: model ? JSON.parse(model) as AppSettings["sessionMetadataModel"] : null,
      defaultSessionModel: defaultSessionModel ? JSON.parse(defaultSessionModel) as AppSettings["defaultSessionModel"] : null,
    };
  }

  updateSettings(input: { autoGenerateSessionMetadata?: boolean | undefined; sessionMetadataModel?: AppSettings["sessionMetadataModel"] | undefined; defaultSessionModel?: AppSettings["defaultSessionModel"] | undefined }): AppSettings {
    const set = this.db.query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    if (input.autoGenerateSessionMetadata !== undefined) set.run("autoGenerateSessionMetadata", String(input.autoGenerateSessionMetadata));
    if (input.sessionMetadataModel !== undefined) set.run("sessionMetadataModel", JSON.stringify(input.sessionMetadataModel));
    if (input.defaultSessionModel !== undefined) set.run("defaultSessionModel", JSON.stringify(input.defaultSessionModel));
    return this.getSettings();
  }

  deleteSession(id: string): boolean {
    const result = this.db.query("DELETE FROM web_sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
