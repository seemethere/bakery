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
bun run dev
```

Open:

```text
http://127.0.0.1:5173/
```

The API runs on `http://127.0.0.1:3141`. In localhost-only mode, an auth token is optional; non-localhost requests are rejected unless a token is configured. If `PI_WEB_WORKSPACE_ROOT` is unset, Bakery creates and uses `~/.bakery/workspaces/local` as the local workspace root.

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

## Containerized development

Bakery also has a Docker Compose path for developing Bakery itself inside a container while editing this checkout from the host:

```bash
cp .env.example .env
# Edit .env: set PI_WEB_AUTH_TOKEN, and on Linux set PI_WEB_CONTAINER_UID/GID.
docker compose up --build
```

Open `http://127.0.0.1:5173/` and use the token from `.env` if prompted. For LAN/Tailscale access, set `PI_WEB_VITE_ALLOWED_HOSTS` and `PI_WEB_PREVIEW_PUBLIC_BASE_URL` in `.env`; see [`docs/container-development.md`](docs/container-development.md#lantailscale-access). The container bind-mounts this repository at `/workspace/bakery` for running the dev server, mounts `$HOME/.bakery/workspaces/docker` at `/workspace/workspaces/docker`, and uses that mounted workspace directory as the default allowed workspace root unless `PI_WEB_WORKSPACE_ROOT` is set. It also mounts `$HOME/.pi` at `/home/bun/.pi` for normal pi auth/resources. Default Compose does not mount Git/GitHub credentials; the image includes `gh`, and [`docs/container-development.md#git-and-github-auth`](docs/container-development.md#git-and-github-auth) covers trusted-dev SSH-agent and GitHub auth override recipes for agents that need fetch, push, or PR tooling inside the container.

Docker socket access is intentionally off by default. When you need Docker commands inside the dev container, opt in explicitly:

```bash
docker compose -f compose.yaml -f compose.docker.yaml up --build
```

See [`docs/container-development.md`](docs/container-development.md) for mounted paths, UID/GID notes, and troubleshooting.

## Common commands

```bash
bun run doctor              # Validate local install readiness
bun run dev                 # Start backend manager, then Vite web UI
bun run dev:lan             # Start backend and web UI for token-protected LAN access
bun run dev:server:restart  # Restart only the backend during development
bun run dev:server:logs     # Show backend logs
bun run check               # Typecheck packages/apps and workflow-skill assertions
docker compose up --build   # Run the containerized Bakery development environment
```

## Important environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_WORKSPACE_ROOT` | `~/.bakery/workspaces/local` | Comma-separated allowlist of directories where sessions may run. Docker Compose defaults this to `/workspace/workspaces/docker`, mounted from `$HOME/.bakery/workspaces/docker`. |
| `PI_WEB_HOST` | `127.0.0.1` | Backend bind host. Use `0.0.0.0` only for LAN/container access with a token. |
| `PI_WEB_PORT` | `3141` | Backend API/WebSocket port. |
| `PI_WEB_AUTH_TOKEN` | unset | Required for non-localhost access; optional on localhost. |
| `PI_WEB_DATA_DIR` | `~/.pi-web-agent` | Base directory for metadata, session files, artifacts, and managed worktrees. |
| `PI_WEB_WORKTREE_DIR` | `$PI_WEB_DATA_DIR/worktrees` | Directory for opt-in isolated Git worktree sessions. |
| `PI_WEB_VITE_ALLOWED_HOSTS` | unset | Comma-separated hostnames allowed by the Vite dev server for LAN/Tailscale access. |
| `PI_WEB_PREVIEW_PUBLIC_BASE_URL` | unset | Public base URL used when Bakery renders Preview Stack links. |

See `apps/server/src/config.ts` for the full set of server configuration knobs.
