# Project Log

Use this file to preserve context between coding sessions. Keep entries short and update the top section before committing.

## Current status

Implemented the first basic vertical slice scaffold plus initial multi-client lifecycle support, improved transcript readability, file/slash-command autocomplete, the first right-side inspector panel, transcript scroll protection with a floating "Jump to latest" affordance, the first session identity/sidebar usability pass, and a compact-successful-tool transcript pass. Current direction after dogfooding feedback is to prioritize workflow usability over broad polish, next focusing on remaining transcript noise and running-control improvements:

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
- Made the fake-agent runner more realistic and deterministic: uneven chunk sizes/cadence, no-delay event bursts, repeated partial Markdown/code fences, and delayed/bursty tool updates interleaved during assistant streaming.
- Added focused Playwright harness coverage for `@file` autocomplete/search+directory continuation, prompt image attachment add/remove/send/render flows, and model/thinking selector updates. This caught and fixed duplicate trailing slashes for directory autocomplete insertion/rendering.
- Added reconnect/restart UX basics: a visible connection-state banner (`connected`/`connecting`/`reconnecting`/`disconnected`/`retry failed`), automatic WebSocket reconnect with backoff, clearer disconnected/send-failed copy, per-session prompt draft persistence in `localStorage`, and warnings that image attachments are prompt-only and not restored after refresh. Added fake-agent harness coverage for reload/reconnect draft preservation and an actual backend process restart (`backend-restart`) that verifies reconnect, draft preservation, and post-restart send usability.
- Improved multi-tab controller handoff: viewer take-control now creates a pending request instead of stealing control from a connected controller, the controller gets inline Approve/Deny controls, requests expire after 30 seconds, and disconnected controllers hand off to a pending requester when possible. Expanded the reconnect/controller harness scenario to cover request approval and post-handoff sending, and added edge coverage for denial, timeout, and disconnected-controller handoff.
- Transcript scrolling now protects scrolled-up reading during streaming: leaving the bottom pauses follow-latest without yanking the transcript, tracks unread transcript item updates, and shows a floating "Jump to latest" button that resumes follow-latest. WebSocket connection close/retry notices stay in the banner instead of adding transcript rows.
- Dogfooding usability findings: running activity/tool output is too visually repetitive; successful tools should collapse into background activity; connection lifecycle events should not appear in transcript; composer/buttons are too large; running steer/follow-up controls should be more TUI-like and sticky/floating; inspector is low-frequency/debug UI; left sidebar should be compact/collapsed by default during active sessions; message actions should live in overflow menus.
- Session identity/sidebar usability pass: header now shows an editable session title with repo/path metadata below it; session lists hide raw UUIDs by default, sort by last activity, show last prompt snippets, relative activity time, and status chips; older-than-one-week sessions are hidden behind a persisted "show older" toggle. `/api/sessions` now enriches metadata from pi JSONL/session state with last activity, last user prompt, and active status.
- Successful tool executions now automatically fold back into a smaller, muted activity row when they transition from running to done, with a compact result preview in the header; running, failed, newly selected, and image-bearing tool rows stay expanded/prominent. Re-clicking an expanded tool header now collapses it instead of immediately reselecting/reopening it; transcript row selection binding is restored after full renders and ignores collapsible headers. The Preview inspector now renders assistant/user content segments so inline image parts preview correctly. The Playwright harness now pre-seeds its API base in localStorage so local dev servers on the default port do not race isolated fake-agent runs.
- Prompt composer/running controls are now more compact and TUI-like: shorter textarea, explicit idle vs running mode hint, Enter/Alt+Enter shortcut labels on buttons, running-state footer emphasis, queued steer/follow-up chips in the composer, and `queue_update` events no longer add transcript noise.
- Transcript rows now have quiet per-message overflow menus for Copy, Details, Preview, and valid user-message Fork actions. The actions select/open the inspector without adding always-visible clutter, and the inspector-preview harness now exercises menu-driven Preview/Details flows.
- The session sidebar now communicates whether it is pinned open or will auto-collapse, and opening an existing recent session auto-collapses the sidebar unless the operator has pinned it open. New/forked sessions and automatic reload restore keep the sidebar open to avoid hiding setup controls or destabilizing harness flows.
- Expanded tool-output ergonomics for long-running bash-style commands: tool result text now renders as terminal-like preformatted output while preserving Markdown image payloads, expanded tool bodies are capped to an internal scroll viewport instead of dominating the full transcript, running tool output pins to the bottom while streaming, and the fake-agent narrow tool harness now emits/asserts long terminal output.

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

Latest: `bun run check` and `bun run test:web-perf` pass after the terminal-like tool-output viewport pass. Latest harness scenario set: `all` (`streaming-responsiveness`, `transcript-scroll-stability`, `inspector-preview`, `slash-commands`, `tree-fork-navigation`, `reconnect-controller`, `controller-handoff-edges`, `reconnect-draft`, `backend-restart`, `narrow-tool-stream`, `file-autocomplete`, `image-attachments`, `model-thinking`); artifacts at `test-results/ui-harness/all-2026-04-26T20-15-12-265Z`. Focused direct runs, `bun scripts/ui-harness.ts --scenario image-attachments` and `bun scripts/ui-harness.ts --scenario narrow-tool-stream`, also passed with artifacts at `test-results/ui-harness/image-attachments-2026-04-26T20-14-49-984Z` and `test-results/ui-harness/narrow-tool-stream-2026-04-26T20-14-52-479Z`. Earlier attempted `bun run test:web-perf -- --scenario streaming-responsiveness` runs invoked the full `all` set and exposed sidebar/harness regressions before the final fix. `bun scripts/ui-harness.ts --scenario manual --keep` opens and seeds the manual headed harness successfully; terminating it via SIGINT prints the artifact/temp paths before shutdown. On a fresh machine, run `bun x playwright install chromium` once if Playwright reports a missing browser.

## Next priorities

1. Continue transcript noise reduction: consider grouping tool call/result pairs and tune compact successful-tool summaries, terminal-output viewport sizing, and queue chips after real-session dogfooding.
2. Continue composer/running-control dogfooding: decide whether queued follow-ups need richer editing/cancel affordances or a floating running strip beyond the compact footer.
3. Continue message-action dogfooding: add retry when backend support is clearer, tune menu hit targets/placement, and consider keyboard access shortcuts.
4. Continue session identity/sidebar dogfooding: validate the existing-session auto-collapse and pin-mode copy in real sessions, then tune status labels/snippets if they feel noisy.
5. Keep dogfooding controller handoff, reconnect/restart UX, and scroll protection with real model sessions; fix duplicate snapshots, stale controller state, scroll edge cases, or confusing retry/copy if they appear.
6. Tighten web-perf thresholds over time once more baseline runs are available, and consider reporting percentile timings in addition to max timings.
7. Add sanitized real-event playback to complement the deterministic fake runner if dogfooding exposes SDK/provider event patterns the fake runner does not cover.
8. Expand branch/tree support beyond basic navigation: add summarize-before-navigation flow, label/bookmark editing, filter/search modes, keyboard navigation, and clearer current-path rendering.
9. Explore `@mariozechner/pi-web-ui` adapter once the remote agent state shape is clearer.

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
