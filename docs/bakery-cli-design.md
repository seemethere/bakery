# Bakery CLI launcher design

Bakery should feel like a local notebook/workbench application: run one command from a project directory, get a localhost web UI, and keep the workspace boundary obvious. This document captures the Jupyter-inspired launcher shape for open-source readiness and the path from the current source-checkout prototype to a published `bakery` command.

## Goals

- Make first-run UX simple for a new technical user: `cd my-project && bakery` should be enough after installation and provider auth.
- Treat the invocation directory as the default trusted workspace, not an implementation detail hidden in environment variables.
- Start or reuse the local Bakery server, print actionable URLs/status, and optionally open the browser.
- Preserve local-first security: localhost by default, token required for intentional non-localhost exposure, and sessions constrained to approved workspace roots.
- Keep the CLI small at first. It should launch and manage Bakery, not duplicate the web app or pi CLI.

## Non-goals for the first published CLI

- Hosted or multi-user server management.
- Full pi terminal command parity.
- A package manager for extensions, skills, or models.
- Cross-machine tunneling or public sharing.
- A background system daemon installed outside the user's chosen command lifecycle.

## Jupyter behavior model

Jupyter's UX works because the terminal command owns a few clear responsibilities:

1. **Directory as workspace**: `jupyter lab` starts with the current directory as the file root.
2. **Local server lifecycle**: the command starts a local server and keeps it attached to the terminal by default.
3. **Browser handoff**: it prints a localhost URL and commonly opens a browser tab.
4. **Port selection**: it uses a known default port, with fallbacks when occupied.
5. **Local auth**: tokenized localhost URLs protect access without asking users to build an auth system first.
6. **Runtime discovery**: users can inspect running servers and shut them down.

Bakery should borrow the shape, not copy every behavior. The most important transfer is the mental model: the CLI turns a directory into a local browser workbench.

## Current state

The repository already has a source-checkout prototype:

```bash
bun run bakery
```

It starts the backend and Vite frontend as foreground child processes, prints the UI/API URLs, defaults `PI_WEB_WORKSPACE_ROOT` to the invocation directory when unset, and stops both children on `Ctrl+C`.

This proves the core interaction but is not yet a distributable `bakery` binary. It also keeps the development two-port shape:

- backend API/WebSocket service on `PI_WEB_PORT` / default `3141`;
- Vite web UI on `PI_WEB_VITE_PORT` / default `5173`.

## Target user experience

### Primary path

```bash
cd ~/projects/example
bakery
```

Expected behavior:

1. Resolve the current directory to a real path.
2. Treat that path as the initial approved workspace root.
3. Start or reuse a compatible local Bakery server.
4. Open the Bakery UI unless `--no-open` is passed.
5. Print concise status:

```text
Bakery is running

  UI:        http://127.0.0.1:3141/?token=...
  Workspace: /Users/alex/projects/example
  Data:      ~/.local/state/bakery
  Logs:      ~/.local/state/bakery/logs/server.log

Press Ctrl+C to stop this server.
```

### Useful flags

MVP flags:

```bash
bakery --help
bakery --version
bakery --no-open
bakery --workspace /path/to/project
bakery --host 127.0.0.1
bakery --port 3141
```

Near-follow-up commands:

```bash
bakery status        # show running server, URL, workspace roots, pid, logs
bakery open          # open the existing UI or start then open
bakery stop          # stop a managed local server
bakery logs          # tail or print recent logs
bakery doctor        # diagnose install/auth/ports/workspace safety
```

Later commands only if demand is clear:

```bash
bakery session new
bakery workspace add /path/to/repo
bakery preview start
bakery config path
```

## Lifecycle model

### Foreground default

The first published CLI should behave like Jupyter and stay in the foreground by default:

- `Ctrl+C` stops the server it started.
- Child output is summarized, with detailed logs written to a runtime log file.
- Crashes stop the command with a clear error and log path.

This is easy to understand for new users and avoids invisible background agents running against a workspace.

### Reuse vs duplicate startup

When `bakery` is invoked, it should detect whether a compatible local server already exists:

- If an existing server is healthy and can approve/open the requested workspace, reuse it and open the UI.
- If the port is occupied by a non-Bakery process, choose a fallback port or fail with a clear message.
- If a stale runtime file exists, ignore or repair it.

Server identity can be tracked with a runtime file containing pid, port, started-at time, version, auth token metadata, and data/log paths. The health endpoint should identify Bakery and version compatibility without exposing secrets.

### Single-port target

For distribution, prefer one local HTTP origin where the backend serves the built frontend assets:

```text
http://127.0.0.1:3141/
http://127.0.0.1:3141/api/...
http://127.0.0.1:3141/api/sessions/:id/ws
```

The current two-port Vite shape should remain for source development, but published CLI users should not need to understand Vite.

## Workspace model

The command invocation directory should become the initial approved workspace, equivalent to setting a narrow `PI_WEB_WORKSPACE_ROOT` for that run.

Rules:

- Resolve symlinks/relative paths before approval.
- Avoid silently approving broad roots such as `/`, the whole home directory, or a drive root without an explicit confirmation or warning.
- Keep session cwd realpath checks on the backend as the enforcement layer.
- Let users add additional approved workspaces in the UI or future CLI commands.

Open question: if an existing server is already running with a different workspace, should `bakery` add the new directory to that server's approved workspaces, start a second server on another port, or ask? The recommended default is to reuse the server and explicitly approve the new workspace, because a single local Bakery instance with multiple approved workspaces matches the current app model.

## Auth and security

Bakery's local-first assumptions still apply:

- Bind to `127.0.0.1` by default.
- Allow unauthenticated localhost in development only if that remains the product policy.
- Require `PI_WEB_AUTH_TOKEN` or a generated token for non-localhost binds.
- Never send provider API keys to the browser.
- Make the trusted workspace boundary visible in CLI output and UI chrome.

For a published CLI, a generated per-server browser token is worth considering even on localhost. It gives Jupyter-like protection against other local pages/processes while keeping the UX simple via an auto-opened token URL.

Security-sensitive CLI output should say plainly that Bakery can run commands and edit files inside approved workspaces.

## Config, runtime, and logs

Prefer platform-appropriate directories, with environment overrides for tests and containers.

Suggested defaults:

| Purpose | macOS/Linux example | Notes |
| --- | --- | --- |
| Config | `$XDG_CONFIG_HOME/bakery` or `~/.config/bakery` | user preferences, default host/port/model policy overrides |
| State | `$XDG_STATE_HOME/bakery` or `~/.local/state/bakery` | SQLite metadata, runtime files, logs |
| Cache | `$XDG_CACHE_HOME/bakery` or `~/.cache/bakery` | downloaded/generated transient data |
| Project-local | `.bakery/` under workspaces | artifacts/attachments already used by sessions |

On macOS, we may later choose `~/Library/Application Support/Bakery` for a more native layout. The MVP can use XDG-style paths consistently if documented.

## Packaging options

### Source checkout prototype

Keep supporting:

```bash
bun run bakery
```

This remains the contributor/development path.

### npm/bun published CLI

Target shape:

```bash
bunx bakery
# or after global install
bakery
```

Packaging decisions before publishing:

- package name/scope (`bakery`, scoped package, or current project package name);
- `bin` entry location;
- whether to include prebuilt web assets;
- whether the backend serves static frontend assets;
- how pi SDK dependencies and optional native dependencies are resolved;
- whether Node compatibility is required or Bun is an explicit runtime prerequisite.

Recommended first published form: Bun-first npm package with a `bin` launcher and prebuilt web assets, requiring Bun to run the backend.

## MVP implementation plan

1. Keep the existing `bun run bakery` source-checkout launcher working.
2. Add CLI parsing for `--no-open`, `--workspace`, `--host`, and `--port`.
3. Move launcher/runtime helpers into testable modules.
4. Add focused tests for argument parsing, workspace resolution, URL formatting, and safe-root warnings.
5. Add browser-open support with a safe opt-out.
6. Add runtime file + health detection for reuse of an existing Bakery server.
7. Build web assets and let the backend serve them on the API port for production mode.
8. Add npm `bin` metadata only after the single-port production mode works.
9. Update quickstart/docs to make `bakery` the primary path and `bun run bakery` the source-checkout path.

## Open questions

- Should localhost always require a generated token in the published CLI, or only when binding beyond loopback?
- Should a second `bakery` invocation reuse the existing server and approve the new workspace, or start a per-directory server?
- What exact npm package name should own the `bakery` binary?
- Should the CLI daemonize with `bakery start`, or keep foreground-only until users ask for background operation?
- Do we want a first-run welcome page when no model/provider auth is detected?
- Should `bakery doctor` live in the CLI package, the backend, or both?

## Readiness checklist

Before open-sourcing with the CLI as the recommended path:

- [ ] Fresh clone quickstart works from a non-Bakery project directory.
- [ ] CLI prints workspace, URL, data/log paths, and stop instructions.
- [ ] Port conflict errors are actionable.
- [ ] Workspace root warnings prevent accidental broad approval.
- [ ] Local auth policy is documented and tested.
- [ ] Browser auto-open can be disabled.
- [ ] `bakery status` or equivalent troubleshooting path exists.
- [ ] Docs distinguish source development from installed usage.
