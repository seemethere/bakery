# Project Log

Use this file to preserve context between coding sessions. Keep entries short and update the top section before committing.

## Current status

Implemented the first basic vertical slice scaffold plus initial multi-client lifecycle support and improved transcript readability:

- Bun workspaces monorepo with `apps/server`, `apps/web`, and `packages/protocol`.
- Shared Zod/TypeScript protocol definitions, including controller state, session lifecycle config, and runtime model/thinking settings.
- Fastify backend with localhost/token auth, workspace allowlist checks, config/workspace/model endpoints, session CRUD, SQLite metadata, and WebSocket session endpoint.
- In-process pi SDK session runner wired for prompt, steer, follow-up, abort, model/thinking changes, snapshots, and normalized event streaming.
- WebSocket session hubs now support reconnect snapshots, multiple clients, first-client controller assignment, take-control, per-client sequence envelopes, and disconnected idle disposal.
- Minimal Vite web component UI for API/token settings, workspace/session list, session creation/opening, WebSocket connection, readable transcript rendering, model/thinking selectors, prompt/steer/follow-up input, abort controls, controller/viewer status, and TUI-like transcript follow-latest auto-scroll.
- Assistant transcript rendering now handles Markdown via `marked`, hides thinking by default with a `Show thinking` toggle, renders readable thinking traces dim/italic when enabled, and formats inline tool calls compactly instead of dumping raw provider JSON/encrypted thinking payloads.
- Tool execution cards now use more TUI-like compact titles, green/blue/red status backgrounds, and cleaner result extraction from text/image/diff/stdout/stderr result payloads.
- Web dev server now disables Vite browser HMR/reload by default so in-browser agent edits do not refresh/kill the UI session; set `PI_WEB_VITE_HMR=true` to opt back in. The web UI also remembers and reopens the last selected session after a page reload.

## How to run

Terminal 1:

```bash
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server
```

Terminal 2:

```bash
bun run dev:web
```

Open `http://127.0.0.1:5173/`. The API URL should be `http://127.0.0.1:3141`. Leave token blank unless `PI_WEB_AUTH_TOKEN` is set.

## Verification

```bash
bun install
bun run check
curl http://127.0.0.1:3141/healthz
```

Latest: `bun run check` passes after disabling default Vite HMR/reload and adding last-session reopen on web refresh.

## Next priorities

1. Test in-browser agent runs that edit the served app/shared packages and confirm the UI stays connected without Vite HMR reloads.
2. Test transcript rendering against real long sessions and tune grouping/collapse behavior for assistant + tool event duplication.
3. Implement ignore-aware file search/complete endpoints for `@file` autocomplete.
4. Add command metadata endpoint and slash-command autocomplete.
5. Add right-side details/preview panel for selected message/tool data.
6. Add basic branch/fork controls and tree summary using pi session manager APIs.
7. Improve controller handoff policy/confirmation and richer reconnect/error UX.
8. Explore `@mariozechner/pi-web-ui` adapter once the remote agent state shape is clearer.

## Session handoff convention

At the end of each work session:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` current status / next priorities if anything changed.
3. Commit with a concise message.
4. In the next AI session, start by reading `DESIGN.md` and `PROJECT_LOG.md`.
