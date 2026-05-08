# Pi Web Agent Design

## Goal

Build a standalone, local-first web application for spawning and interacting with server-backed pi coding-agent sessions. The frontend should use `@mariozechner/pi-web-ui` where practical, while the backend embeds pi through the `@mariozechner/pi-coding-agent` SDK.

Reference source lives under `.ref/pi-mono` and is not part of this app.

## Non-goals for v1

- Multi-user hosted SaaS.
- Full terminal parity for every pi command.
- Native web-managed subagent orchestration.
- In-flight recovery after server restart.
- Full artifact tool integration.
- General document/PDF attachment ingestion.

## Architecture

```text
Browser UI
  | HTTP + WebSocket
  v
Bun-first TypeScript web service
  | @mariozechner/pi-coding-agent SDK
  v
Pi AgentSession / AgentSessionRuntime
  | default pi tools/resources
  v
Workspace filesystem
```

The app is standalone from `pi-mono`, using published npm packages by default.

## Project shape

Use a small Bun/npm-workspaces monorepo:

```text
pi-web-agent/
  DESIGN.md
  package.json
  apps/
    server/
    web/
  packages/
    protocol/
```

- `apps/server`: Bun-first backend.
- `apps/web`: Vite + TypeScript + web components.
- `packages/protocol`: shared protocol constants, Zod schemas, and TypeScript types.

## Runtime and framework

- Package manager/runtime preference: **Bun-first**.
- Keep Node compatibility where practical.
- Bun-specific APIs must sit behind interfaces where reasonable.
- Preferred backend framework: **Fastify on Bun**.
- If Fastify WebSocket/static behavior is problematic under Bun, fall back to `Bun.serve`.
- SQLite should use `bun:sqlite` initially, behind a metadata-store interface.

## Deployment modes

Support both local and container deployment.

Local:

```bash
PI_WEB_HOST=127.0.0.1
PI_WEB_PORT=3141
PI_WEB_WORKSPACE_ROOT=~/projects
PI_WEB_AUTH_TOKEN=...
bun run start
```

### Local CLI distribution

The intended local distribution shape is a notebook-style Bakery Launcher: the operator runs a command from a workspace, Bakery starts the local backend and browser UI, and the command prints the localhost UI address. The simple future target is `bunx bakery`, but npm packaging is not part of the first launcher slice.

The initial source-checkout prototype may keep the current two-process shape: backend API/WebSocket service plus Vite frontend on separate localhost ports. Local-first security assumptions stay the same: localhost by default, token required for non-localhost access, and session cwd constrained to backend-allowlisted workspace roots. Later packaging must decide the npm package name/scope, `bin` metadata, included build artifacts, whether the backend serves static frontend assets on one port, and how dependencies are bundled or installed.

Container:

```bash
docker run \
  -p 3141:3141 \
  -e PI_WEB_AUTH_TOKEN=... \
  -e PI_WEB_WORKSPACE_ROOT=/workspace \
  -v "$PWD:/workspace" \
  -v "$HOME/.pi:/home/node/.pi" \
  pi-web-agent
```

## Security model

v1 is single-user/local-first.

- Require simple shared bearer token when configured.
- Bind to localhost by default.
- If no token is configured, only allow unauthenticated localhost access.
- Workspace roots are allowlisted by backend config.
- Session cwd must resolve under an allowed root using realpath checks.
- The agent can execute shell commands and modify files available to the server process.
- Containerization is the recommended security boundary for broader exposure.

Tool permission modes:

```ts
type ToolPermissionMode = "bypass" | "confirm" | "deny";
```

Policy:

```ts
type ToolPermissionPolicy = {
  allowedModes: ToolPermissionMode[];
  defaultMode: ToolPermissionMode;
  confirmTools: string[];
  denyTools: string[];
};
```

Local default: allow `bypass` and `confirm`, default `bypass`.

## Workspaces and sessions

- One web/pi session is bound to one immutable workspace directory.
- Changing projects means creating/opening another session.
- Sessions may optionally be isolated by creating a managed Git worktree for the session. In that mode the session `cwd` is the worktree path, the source repo/cwd is kept as metadata, and Bakery creates a named branch such as `bakery/session/<short-id>` from the source `HEAD`.
- If the source repo has uncommitted changes when creating an isolated worktree session, v1 warns that the worktree starts from `HEAD`; it does not copy dirty source changes.
- Use pi native JSONL session files as the source of truth for conversation history, model state, and tree/branch structure.
- The web app stores only metadata/index data in SQLite.

Minimal metadata:

```sql
web_sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  pi_session_file TEXT NOT NULL,
  isolation_kind TEXT NOT NULL DEFAULT 'none',
  source_cwd TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  worktree_base_commit TEXT,
  worktree_source_dirty INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

session_preferences (
  web_session_id TEXT PRIMARY KEY,
  tool_permission_mode TEXT,
  ui_state_json TEXT
);
```

Titles and summaries:

- The canonical visible session title lives in web metadata and is used by the header, sidebar, `/name`, and future generated metadata flows.
- Titles track provenance: `unset`, `first_prompt`, `agent`, `manual`, or `derived`.
- Summaries track provenance: `unset`, `agent`, `manual`, or `derived`.
- Manual/user-approved metadata is protected from automatic overwrite. Clearing a field returns it to `unset`.
- Specific first prompts may create an immediate provisional `first_prompt` title; generic prompts like “what's next?” remain untitled and display a temporary “New session” label/snippet until enough context exists.
- Title/summary generation is explicit and separate from the main transcript; it should not add conversation messages or mutate the session tree.
- To avoid surprise token spend, generation runs only when the user clicks the magic title/summary action. Automatic background generation is deferred.
- The magic action generates title+summary suggestions inline; accepting suggestions marks those fields as `manual`.
- Session summaries are plain-text web metadata, collapsed by default, and expandable in session chrome/sidebar/details rather than transcript content.

## Pi SDK integration

Use the SDK, not `pi --mode rpc`, for v1.

Use an execution abstraction:

```ts
interface PiSessionRunner {
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;
  getSession(id: string): SessionHandle | undefined;
  disposeSession(id: string): Promise<void>;
}
```

Initial implementation:

```ts
class InProcessPiSessionRunner implements PiSessionRunner {}
```

Future implementations may use worker processes or containers.

Use `AgentSessionRuntime` where session replacement is needed, e.g. new/resume/fork/clone.

## Resources: extensions, skills, templates, context

Use backend policy-controlled resource loading. Bakery-specific web extension architecture is tracked in [`docs/extensions-design.md`](docs/extensions-design.md); the first implementation should keep pi SDK extensions as the agent/runtime layer and add typed Bakery extension points for browser UI, workflow commands, and local backend actions.

```ts
type ResourcePolicy = {
  loadGlobalResources: boolean;
  loadProjectResources: boolean;
  allowExtensions: boolean;
  allowSkills: boolean;
  allowPromptTemplates: boolean;
  allowContextFiles: boolean;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
};
```

Local defaults should be close to normal pi behavior. Container/hosted configurations may disable global resources or extensions.

## Credentials and models

- Model provider credentials are backend-only.
- Use existing pi mechanisms: env vars, `~/.pi/agent/auth.json`, configured provider auth, mounted secrets.
- Browser should not store provider API keys for server-backed sessions.

Model/thinking policy:

```ts
type ModelPolicy = {
  defaultModel?: string;
  allowedModels?: string[];
  defaultThinkingLevel: string;
  allowedThinkingLevels: string[];
};
```

Backend owns policy; UI exposes only allowed choices.

## HTTP API

Use HTTP for bootstrap, listing, metadata, search, tree, and other request/response operations.

Initial v1 surface:

```http
GET    /healthz
GET    /api/config
GET    /api/workspaces
GET    /api/models
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id
DELETE /api/sessions/:id
GET    /api/sessions/:id/tree
POST   /api/sessions/:id/fork
GET    /api/sessions/:id/files/search
GET    /api/sessions/:id/files/complete
GET    /api/sessions/:id/commands
```

Use Zod for validation at all external boundaries.

## WebSocket protocol

Use WebSocket for live session interaction.

```text
WS /api/sessions/:id/ws
```

Protocol should be versioned and typed in `packages/protocol`.

Handshake:

```json
{ "type": "hello", "protocolVersion": 1, "sessionId": "...", "serverVersion": "..." }
{ "type": "hello_ack", "protocolVersion": 1, "clientId": "..." }
```

Server messages are enveloped with sequence numbers:

```ts
type ServerEnvelope = {
  seq: number;
  time: string;
  payload: ServerMessage;
};
```

On connect, server sends a full session snapshot, then live events.

HTTP can also fetch session state. Reconnect behavior in v1 is snapshot-based; persisted event replay is deferred.

## Event translation

Use a hybrid event model:

- Normalize enough for stable UI rendering.
- Optionally include raw pi SDK event payloads for debugging and future compatibility.

Example:

```ts
type ServerMessage =
  | { type: "session_snapshot"; snapshot: SessionSnapshot }
  | { type: "agent_event"; event: NormalizedAgentEvent; raw?: unknown }
  | { type: "controller_update"; controller?: ControllerInfo }
  | { type: "error"; code: string; message: string };
```

Normalized events should cover:

- state updates
- message deltas
- tool call start/update/end
- agent status: idle/running/aborting/error
- model/thinking changes
- permission request events, when confirm mode exists

## Live controls

Support important pi controls in v1:

- prompt
- steer while running
- follow-up queue
- abort
- compact
- new session
- resume/open session
- fork/clone basics
- model changes
- thinking-level changes

When running, UI should show both **Steer** and **Follow-up** controls.

Keyboard behavior:

```text
Enter       -> steer while running, normal send while idle
Alt+Enter   -> follow-up while running
```

## Multiple clients and lifecycle

Multiple browser tabs may connect to the same session.

- Multiple viewers allowed.
- One controller per session.
- First connected tab becomes controller.
- Viewers can request/take control with UI confirmation/config policy.

Disconnected session lifecycle:

```ts
type SessionLifecycleConfig = {
  disconnectedIdleTimeoutMs: number;
  disconnectedRunningPolicy: "let-finish" | "abort-after-timeout";
};
```

Default:

- keep disconnected sessions for 15 minutes
- let running work finish

Server restart behavior:

- No in-flight recovery in v1.
- Reopen persisted pi session files after restart.
- Graceful shutdown should notify clients and dispose sessions best-effort.

## Frontend

Use plain Vite + TypeScript + web components.

Try adapter-first with `@mariozechner/pi-web-ui`:

```ts
class RemotePiAgent {
  prompt(...): Promise<void>;
  followUp(...): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener): () => void;
  state: RemoteAgentState;
}
```

Attempt to use `ChatPanel` via a compatible adapter. If blocked by concrete `Agent` assumptions, build a minimal custom chat UI for v1 and reuse `pi-web-ui` styles/components where practical.

Layout:

- central chat
- collapsible/compact left sidebar for workspaces/sessions
- tabbed right sidebar: Details / Preview / Tree, treated as lower-frequency/debug UI and collapsible by default when it competes with the main chat

Dogfooding usability direction:

- Prioritize workflow friction over broad visual polish.
- Make the current session identity prominent in the header: editable session title first, workspace/repo/path as secondary metadata.
- Treat the session sidebar as a recent-work/attention list rather than a raw database. Sort by recent activity/open time, show only sessions accessed within the last week by default, and provide an explicit "show older" affordance.
- Session cards should eventually show useful recognition and attention metadata: title, last user prompt/activity snippet, relative time, and running/waiting/finished/error indicator. Hide raw UUIDs by default.
- Collapse the left sidebar by default once an active session is selected, unless the user has explicitly pinned/opened it.
- Preserve user reading position in the transcript. If the user scrolls up, live updates must not yank the view to the bottom; show a floating "Jump to latest" affordance instead.
- Keep lifecycle/connection noise out of the transcript. Use banners/toasts/header status for reconnects and WebSocket state; reserve transcript entries for user-visible conversation, intentional command results, meaningful agent work, and actionable errors.
- Make successful tool calls background activity by default: compact/collapsed after completion, failed/running tools prominent, and current activity visible as a clear status strip.
- Shrink the composer footprint and make running-state controls more TUI-like: obvious steer vs follow-up modes, queued follow-ups visible in a sticky/floating control area, and smaller buttons/textarea by default.
- Prefer per-message overflow menus for actions such as copy, fork, retry, preview, and details instead of always-visible controls.

## UI features

v1 should include:

- session list and workspace selection
- new/open/resume session
- prominent current session identity with editable title
- recent/active session list with useful snippets/status rather than raw IDs
- central transcript and compact input
- stable transcript reading position plus "Jump to latest"
- model and thinking selectors based on backend policy
- command autocomplete
- basic `@file` autocomplete
- collapsed successful tool cards and prominent failed/running tool cards
- abort/steer/follow-up controls with clear running-state mode
- image paste/upload attachments only
- basic branch controls
- right sidebar tabs

Later priority:

- full tree UI
- richer terminal-like tool output pane
- document/PDF attachments
- artifact bridge tool
- native web-managed subagents

## Slash commands and autocomplete

Use a hybrid slash-command strategy.

- Text input can send slash commands to backend/pi.
- UI-native controls exist for common commands.
- Autocomplete is important in v1.
- Backend exposes command metadata for built-ins, prompt templates, skills, and extension commands.
- Terminal-only commands should return structured unsupported events rather than hanging.

## Files and attachments

File autocomplete:

```http
GET /api/sessions/:id/files/search?q=button
GET /api/sessions/:id/files/complete?prefix=src/com
```

Rules:

- search only under session workspace
- return relative paths
- limit results
- respect ignore rules where practical

Attachments:

- v1 supports image paste/upload/drag-drop.
- Send images through SDK prompt image options.
- General documents are deferred.

## Tool rendering

Use collapsible tool cards in v1.

Show:

- tool name/label
- status
- parameters summary
- streamed output where available
- exit code/errors
- copy controls

Defaults:

- successful tools collapse after completion and should feel like compact background activity
- failed tools remain expanded/prominent
- currently running tool/activity remains visible and easy to scan
- adjacent tool call/result rows may be grouped where practical to reduce transcript noise

Right sidebar Details tab can show full selected tool data, but the main transcript should remain useful without requiring the inspector.

## Artifacts and preview

v1 uses UI-only artifact/preview support.

- Render Markdown/code normally.
- Allow “open as preview” for HTML/SVG/Markdown/code blocks or workspace files.
- Do not expose a first-class artifact tool to pi in v1.

## Branching and tree

v1 exposes basic branch controls:

- fork from selected message
- clone current path if easy
- open/resume sessions
- basic tree/path summary

Full session tree UI is an important later milestone and should be supported by API design from the beginning.

## Subagents

v1 supports subagent mechanisms only through normal pi extensions/packages if installed.

Native web-managed subagents are a future major feature:

- spawn child sessions
- nested views
- interrupt/abort child
- stream child events
- return child result to parent

## Observability

Use structured logs with IDs.

Include fields like:

```ts
{
  level,
  time,
  msg,
  requestId,
  webSessionId,
  piSessionId,
  clientId,
  cwd,
  seq,
  eventType
}
```

Expose:

```http
GET /healthz
GET /api/debug/sessions
```

Debug endpoints must be token-protected.

## First vertical slice checklist

1. Create monorepo skeleton with Bun workspaces.
2. Add shared protocol package with protocol version, Zod schemas, and message types.
3. Implement server config, token auth, workspace allowlist, and health endpoint.
4. Implement SQLite metadata store.
5. Implement in-process SDK session runner for creating/opening a session by cwd.
6. Implement WebSocket handshake, snapshot, sequence envelopes, and prompt/abort messages.
7. Stream normalized pi events plus raw event payloads.
8. Build minimal frontend connection flow and transcript rendering.
9. Add input with prompt, running-state steer/follow-up, and abort.
10. Add session list/workspace creation.
11. Add model/thinking selectors.
12. Add basic command and `@file` autocomplete.
13. Add collapsible tool cards.
14. Add basic branch/fork controls.
