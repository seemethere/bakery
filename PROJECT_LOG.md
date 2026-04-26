# Project Log

Use this file to preserve context between coding sessions. Keep entries short and update the top section before committing.

## Current status

Implemented the first basic vertical slice scaffold plus initial multi-client lifecycle support, improved transcript readability, file/slash-command autocomplete, and the first right-side inspector panel:

- Bun workspaces monorepo with `apps/server`, `apps/web`, and `packages/protocol`.
- Shared Zod/TypeScript protocol definitions, including controller state, session lifecycle config, and runtime model/thinking settings.
- Fastify backend with localhost/token auth, workspace allowlist checks, config/workspace/model endpoints, session CRUD, SQLite metadata, and WebSocket session endpoint.
- In-process pi SDK session runner wired for prompt, steer, follow-up, abort, model/thinking changes, snapshots, and normalized event streaming.
- WebSocket session hubs now support reconnect snapshots, multiple clients, first-client controller assignment, take-control, per-client sequence envelopes, and disconnected idle disposal.
- Minimal Vite web component UI for API/token settings, workspace/session list, session creation/opening, WebSocket connection, readable transcript rendering, model/thinking selectors, prompt/steer/follow-up input, abort controls, controller/viewer status, and TUI-like transcript follow-latest auto-scroll.
- Assistant transcript rendering now handles Markdown via `marked`, hides thinking by default with a `Show thinking` toggle, renders readable thinking traces dim/italic when enabled, and formats inline tool calls compactly instead of dumping raw provider JSON/encrypted thinking payloads.
- Tool execution cards now use more TUI-like compact titles, green/blue/red status backgrounds, and cleaner result extraction from text/image/diff/stdout/stderr result payloads.
- Web dev server now disables Vite browser HMR/reload by default so in-browser agent edits do not refresh/kill the UI session; set `PI_WEB_VITE_HMR=true` to opt back in. Server `dev` now runs without Bun watch by default so edits to backend/shared packages do not restart and kill in-process pi sessions; use `bun run dev:server:watch` to opt into backend watch mode. The web UI also remembers and reopens the last selected session after a page reload.
- File search/complete endpoints now call the ignore-aware workspace scanner, validate query params with shared Zod schemas, cap result limits, skip default heavy/binary paths, and keep nested `.gitignore` rules scoped to their subtree.
- Prompt input now has `@file` autocomplete backed by the file search/complete endpoints, with keyboard navigation, click selection, directory continuation, and prompt draft preservation across live transcript rerenders; fixed dropdown closing during rerenders while the prompt remains focused.
- Added shared command metadata protocol, `GET /api/sessions/:id/commands`, and prompt-box slash-command autocomplete for built-ins, extension commands, prompt templates, and skills; terminal/UI-only built-ins are marked unsupported in metadata.
- WebSocket prompt handling now intercepts built-in slash commands before they reach the LLM as normal prompts. Implemented web results for `/reload`, `/changelog`, `/session`, `/compact`, `/name`, and `/copy`; unsupported built-ins render a structured web error instead of being sent to the agent.
- Fixed the server startup regression from the `/changelog` implementation by replacing Bun-incompatible `createRequire(...).resolve("@mariozechner/pi-coding-agent")` usage with `import.meta.resolve` for locating the pi package changelog.
- Fixed command and file autocomplete keyboard navigation so the dropdown scrolls to keep the selected row visible after arrow-key selection changes.
- Fixed the follow-up regression from that change: initial render no longer calls `querySelector("")`, so the app refreshes workspaces/sessions instead of staying empty.
- Added a right-side Details/Preview inspector panel: transcript messages/tool cards are selectable, selection and collapse state persist locally, Details shows compact metadata/content plus collapsible raw event data with copy controls, and Preview renders Markdown/code plus sandboxed HTML/SVG snippets.
- Improved streaming UI responsiveness by throttling WebSocket-driven renders, reducing transcript follow-scroll layout work, and caching rendered transcript segment HTML.
- Added basic session tree/fork/navigation support: shared tree/fork/navigate protocol schemas, `GET /api/sessions/:id/tree`, `POST /api/sessions/:id/fork`, `POST /api/sessions/:id/tree/navigate`, a right-inspector Tree tab, and a TUI-inspired wide tree drawer opened with `/tree`; rows navigate within the current pi session and user-message entries can fork a new web session.
- Reduced streaming render lockups by throttling live renders further, patching only dirty transcript items during active runs instead of replacing the whole app shell, and rendering live assistant Markdown as escaped plain text until the message completes.
- Added an agent-operable Playwright UI harness: `PI_WEB_FAKE_AGENT=1` enables a deterministic fake session runner, `bun run test:web-perf` starts backend/web against temp dirs, drives the real browser UI, measures prompt/control responsiveness during synthetic streaming, and writes screenshots/traces/metrics under ignored `test-results/`; `bun run ui:manual` opens a headed fake-agent browser session for exploratory manual validation until Ctrl+C.
- The left workspace/session sidebar is now collapsible, with state persisted in local storage and compatible grid sizing when the right inspector is also collapsed.
- Assistant Markdown, assistant/user image content parts, and tool-result image content now render safe inline images (`http(s)`, `file`, app-relative, and base64 `data:image/png|jpeg|gif|webp`); tool cards containing rendered images stay open by default, and the fake-agent runner can emit a sample inline PNG when prompts mention images/screenshots for visual validation.
- Prompt composer now supports image attachments for new prompts via paste, drag/drop, or file picker, with thumbnails/removal before send; attached images are sent over the WebSocket prompt message into `AgentSession.prompt(..., { images })` and render back in the transcript. After send, attachment thumbnails clear immediately, and image-only sends use a default inspection prompt.
- Expanded `bun run test:web-perf` into an all-scenarios fake-agent suite covering streaming responsiveness, inspector Details/Preview, slash commands, tree/fork/navigation, reconnect/controller handoff, and narrow tool-heavy streams. Harness metrics now include Chromium long-task samples plus app-exported render/patch timing via `window.__piWebPerf`; fake-agent sessions now persist enough JSONL tree data to exercise tree navigation and fork flows.
- Refactored transcript rows into dedicated `<pi-transcript-row>` custom elements. Live patches now update existing row instances, and actively streaming assistant/user text updates the existing `<pre>` `textContent` without replacing the row HTML. `window.__piWebPerf` now also records row-update timings.
- Added web-perf threshold checks to the Playwright harness for long tasks plus render/patch/row-update max timings. Thresholds are intentionally loose and configurable with `PI_WEB_PERF_MAX_*`; set `PI_WEB_PERF_THRESHOLDS=off` to disable locally.
- Fixed transcript selection scroll jumps: clicking an earlier message/image/tool while auto-scroll is enabled now preserves the current transcript scroll position instead of jumping to the bottom.

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
bun run test:web-perf
bun run ui:manual
curl http://127.0.0.1:3141/healthz
```

Latest: `bun run check` and `bun run test:web-perf` pass after fixing transcript selection/image-click scroll preservation. Latest harness scenario set: `all` (`streaming-responsiveness`, `inspector-preview`, `slash-commands`, `tree-fork-navigation`, `reconnect-controller`, `narrow-tool-stream`); artifacts at `test-results/ui-harness/all-2026-04-26T18-32-28-072Z`. Earlier transcript-row perf run artifacts are at `test-results/ui-harness/all-2026-04-26T18-28-10-743Z`. `bun scripts/ui-harness.ts --scenario manual --keep` opens and seeds the manual headed harness successfully; terminating it via SIGINT prints the artifact/temp paths before shutdown. On a fresh machine, run `bun x playwright install chromium` once if Playwright reports a missing browser.

## Next priorities

1. Manually spot-check real-model streaming with a small model after the transcript-row refactor; current browser page needs refresh to pick up frontend changes, backend needs restart for `PI_WEB_FAKE_AGENT`/server changes.
2. Tighten web-perf thresholds over time once more baseline runs are available, and consider reporting percentile timings in addition to max timings.
3. Make the fake runner more realistic with uneven token cadence, event bursts, partial markdown/code fences, and delayed/interleaved tool updates; longer term, add sanitized real-event playback.
4. Expand branch/tree support beyond basic navigation: add summarize-before-navigation flow, label/bookmark editing, filter/search modes, keyboard navigation, and clearer current-path rendering.
5. Improve controller handoff policy/confirmation and richer reconnect/error UX.
6. Add more focused harness coverage for image attachment edge cases, file autocomplete, model/thinking selectors, copy buttons/clipboard fallbacks, and mobile breakpoints.
7. Explore `@mariozechner/pi-web-ui` adapter once the remote agent state shape is clearer.

## Session handoff convention

At the end of each work session:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` current status / next priorities if anything changed.
3. Tell the human operator how to test the changes manually, including whether the current browser page can pick them up automatically, requires a page refresh, or requires a backend/dev-server restart.
4. Commit with a concise message.
5. In the next AI session, start by reading `DESIGN.md` and `PROJECT_LOG.md`.

## UI validation convention

- UI-affecting changes should run `bun run test:web-perf` after `bun run check`.
- Use `bun run ui:manual` for headed fake-agent exploratory validation in a temp workspace.
- Include harness scenario names and artifact paths in handoffs.
- If a new UI feature is not covered by the harness, extend `scripts/ui-harness.ts` with a scenario before relying on human-only manual testing where practical.
