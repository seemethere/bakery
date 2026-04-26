import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { AppSettings, AutoGenerateMetadataOverride, SummarySource, TitleSource, ToolPermissionMode, WebSession } from "@pi-web-agent/protocol";

export type SessionPreferences = {
  webSessionId: string;
  toolPermissionMode: ToolPermissionMode | null;
  uiStateJson: string | null;
};

type SessionRow = {
  id: string;
  cwd: string;
  pi_session_file: string;
  title: string | null;
  title_source: TitleSource;
  summary: string | null;
  summary_source: SummarySource;
  summary_updated_at: string | null;
  metadata_generation_count: number;
  metadata_last_generated_at: string | null;
  auto_generate_metadata_override: AutoGenerateMetadataOverride;
  created_at: string;
  last_opened_at: string;
};

function mapSession(row: SessionRow): WebSession {
  return {
    id: row.id,
    cwd: row.cwd,
    piSessionFile: row.pi_session_file,
    title: row.title,
    titleSource: row.title_source,
    summary: row.summary,
    summarySource: row.summary_source,
    summaryUpdatedAt: row.summary_updated_at,
    metadataGenerationCount: row.metadata_generation_count,
    metadataLastGeneratedAt: row.metadata_last_generated_at,
    autoGenerateMetadataOverride: row.auto_generate_metadata_override,
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
    `);
    this.addColumn("web_sessions", "title_source TEXT NOT NULL DEFAULT 'unset'", "title_source");
    this.addColumn("web_sessions", "summary TEXT", "summary");
    this.addColumn("web_sessions", "summary_source TEXT NOT NULL DEFAULT 'unset'", "summary_source");
    this.addColumn("web_sessions", "summary_updated_at TEXT", "summary_updated_at");
    this.addColumn("web_sessions", "metadata_generation_count INTEGER NOT NULL DEFAULT 0", "metadata_generation_count");
    this.addColumn("web_sessions", "metadata_last_generated_at TEXT", "metadata_last_generated_at");
    this.addColumn("web_sessions", "auto_generate_metadata_override TEXT NOT NULL DEFAULT 'default'", "auto_generate_metadata_override");
    this.inferExistingTitleSources();
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

  createSession(input: { id: string; cwd: string; piSessionFile: string; title?: string | null; titleSource?: TitleSource; summary?: string | null; summarySource?: SummarySource }): WebSession {
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO web_sessions (id, cwd, pi_session_file, title, title_source, summary, summary_source, summary_updated_at, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.cwd, input.piSessionFile, input.title ?? null, input.titleSource ?? (input.title ? "manual" : "unset"), input.summary ?? null, input.summarySource ?? (input.summary ? "derived" : "unset"), input.summary ? now : null, now, now);
    this.db.query("INSERT INTO session_preferences (web_session_id) VALUES (?)").run(input.id);
    const session = this.getSession(input.id);
    if (!session) throw new Error("Failed to create session");
    return session;
  }

  touchSession(id: string): void {
    this.db.query("UPDATE web_sessions SET last_opened_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  updateSession(id: string, input: { title?: string | null; titleSource?: TitleSource; summary?: string | null; summarySource?: SummarySource; autoGenerateMetadataOverride?: AutoGenerateMetadataOverride; incrementGenerationCount?: boolean }): WebSession | undefined {
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
    if (input.incrementGenerationCount) {
      this.db.query("UPDATE web_sessions SET metadata_generation_count = metadata_generation_count + 1, metadata_last_generated_at = ? WHERE id = ?").run(now, id);
    }
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

  getSettings(): AppSettings {
    const get = (key: string) => this.db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;
    const model = get("sessionMetadataModel");
    return {
      autoGenerateSessionMetadata: get("autoGenerateSessionMetadata") !== "false",
      sessionMetadataModel: model ? JSON.parse(model) as AppSettings["sessionMetadataModel"] : null,
    };
  }

  updateSettings(input: { autoGenerateSessionMetadata?: boolean | undefined; sessionMetadataModel?: AppSettings["sessionMetadataModel"] | undefined }): AppSettings {
    const set = this.db.query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    if (input.autoGenerateSessionMetadata !== undefined) set.run("autoGenerateSessionMetadata", String(input.autoGenerateSessionMetadata));
    if (input.sessionMetadataModel !== undefined) set.run("sessionMetadataModel", JSON.stringify(input.sessionMetadataModel));
    return this.getSettings();
  }

  deleteSession(id: string): boolean {
    const result = this.db.query("DELETE FROM web_sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
