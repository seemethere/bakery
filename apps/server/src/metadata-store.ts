import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { ToolPermissionMode, WebSession } from "@pi-web-agent/protocol";

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
  created_at: string;
  last_opened_at: string;
};

function mapSession(row: SessionRow): WebSession {
  return {
    id: row.id,
    cwd: row.cwd,
    piSessionFile: row.pi_session_file,
    title: row.title,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
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
    `);
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

  createSession(input: { id: string; cwd: string; piSessionFile: string; title?: string | null }): WebSession {
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO web_sessions (id, cwd, pi_session_file, title, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.cwd, input.piSessionFile, input.title ?? null, now, now);
    this.db.query("INSERT INTO session_preferences (web_session_id) VALUES (?)").run(input.id);
    const session = this.getSession(input.id);
    if (!session) throw new Error("Failed to create session");
    return session;
  }

  touchSession(id: string): void {
    this.db.query("UPDATE web_sessions SET last_opened_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  updateSession(id: string, input: { title?: string | null }): WebSession | undefined {
    if (Object.hasOwn(input, "title")) {
      this.db.query("UPDATE web_sessions SET title = ? WHERE id = ?").run(input.title ?? null, id);
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

  deleteSession(id: string): boolean {
    const result = this.db.query("DELETE FROM web_sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
