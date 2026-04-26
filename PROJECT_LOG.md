# Project Log

Use this file to preserve context between coding sessions. Keep entries short and update the top section before committing.

## Current status

Implemented the first basic vertical slice scaffold:

- Bun workspaces monorepo with `apps/server`, `apps/web`, and `packages/protocol`.
- Shared Zod/TypeScript protocol definitions.
- Fastify backend with localhost/token auth, workspace allowlist checks, config/workspace/model endpoints, session CRUD, SQLite metadata, and WebSocket session endpoint.
- In-process pi SDK session runner wired for prompt, steer, follow-up, abort, snapshots, and normalized event streaming.
- Minimal Vite web component UI for API/token settings, workspace/session list, session creation/opening, WebSocket connection, readable transcript rendering, prompt/steer/follow-up input, and abort controls.

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

## Next priorities

1. Improve WebSocket/session lifecycle: reconnect, multiple clients, controller status, and richer error states.
2. Add model and thinking selectors wired through backend policy and pi session changes.
3. Implement ignore-aware file search/complete endpoints for `@file` autocomplete.
4. Add command metadata endpoint and slash-command autocomplete.
5. Add collapsible tool cards and right-side details panel.
6. Add basic branch/fork controls and tree summary using pi session manager APIs.
7. Persist/update default session titles from the first user prompt.
8. Explore `@mariozechner/pi-web-ui` adapter once the remote agent state shape is clearer.

## Session handoff convention

At the end of each work session:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` current status / next priorities if anything changed.
3. Commit with a concise message.
4. In the next AI session, start by reading `DESIGN.md` and `PROJECT_LOG.md`.
