# Bakery

Bakery is a local-first web UI for running server-backed pi coding-agent sessions against your own workspaces. It is currently aimed at pi users and developers who are comfortable running a Bun app from a terminal.

## Quickstart: local Bun install

### 1. Prerequisites

- [Bun](https://bun.sh/) installed.
- A local project directory you are comfortable letting an agent read, edit, and run shell commands inside.
- Usual pi/model provider authentication available to the server process. Bakery uses the published `@mariozechner/pi-coding-agent` SDK and normal pi resources by default.

### 2. Install dependencies

```bash
bun install
```

### 3. Check the local setup

```bash
bun run doctor
```

The doctor checks that Bun is available, dependencies are installed, workspace/data directories are usable, ports look available, and the current host/token settings are safe for local mode.

### 4. Start Bakery for one local machine

```bash
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev
```

Open:

```text
http://127.0.0.1:5173/
```

The API runs on `http://127.0.0.1:3141`. In localhost-only mode, an auth token is optional; non-localhost requests are rejected unless a token is configured.

## LAN mode: use Bakery from another device

LAN mode is explicit because Bakery controls an agent that can modify files and execute shell commands inside the allowed workspace roots.

First check the LAN setup:

```bash
PI_WEB_AUTH_TOKEN="change-me" PI_WEB_WORKSPACE_ROOT="$PWD" bun run doctor --lan
```

Then start both dev servers on the LAN interface:

```bash
PI_WEB_AUTH_TOKEN="change-me" PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:lan
```

Open the printed LAN URL from another device, for example:

```text
http://192.168.1.123:5173/
```

Enter the same token in the app settings if prompted. Keep `PI_WEB_WORKSPACE_ROOT` narrow, such as a single project directory, rather than your whole home directory.

For hostname-based setup and custom Vite host allowlists, see [`docs/local-network.md`](docs/local-network.md).

## Common commands

```bash
bun run doctor              # Validate local install readiness
bun run dev                 # Start backend manager, then Vite web UI
bun run dev:lan             # Start backend and web UI for token-protected LAN access
bun run dev:server:restart  # Restart only the backend during development
bun run dev:server:logs     # Show backend logs
bun run check               # Typecheck packages/apps and workflow-skill assertions
```

## Important environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_WORKSPACE_ROOT` | current working directory | Comma-separated allowlist of directories where sessions may run. |
| `PI_WEB_HOST` | `127.0.0.1` | Backend bind host. Use `0.0.0.0` only for LAN/container access with a token. |
| `PI_WEB_PORT` | `3141` | Backend API/WebSocket port. |
| `PI_WEB_AUTH_TOKEN` | unset | Required for non-localhost access; optional on localhost. |
| `PI_WEB_DATA_DIR` | `~/.pi-web-agent` | Base directory for metadata, session files, artifacts, and managed worktrees. |
| `PI_WEB_WORKTREE_DIR` | `$PI_WEB_DATA_DIR/worktrees` | Directory for opt-in isolated Git worktree sessions. |

See `apps/server/src/config.ts` for the full set of server configuration knobs.
