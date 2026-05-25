# Bakery

Bakery is a local-first web UI for running server-backed pi coding-agent sessions against your own workspaces. It is currently aimed at pi users and developers who are comfortable running a Bun app from a terminal.

## Running Bakery

The intended simple case is a notebook-style launcher:

```bash
bakery
```

From a source checkout, install the command once:

```bash
npm install -g /path/to/bakery
```

Then run `bakery` from the project directory you want to use as the workspace. The installed source-checkout command is foreground-first: it starts the backend on `http://127.0.0.1:3141`, starts the Vite UI on `http://127.0.0.1:5173/`, prints both URLs plus the selected workspace root, and stops both processes when you press Ctrl+C. It also writes a small runtime file under `~/.local/state/bakery` so a second terminal can run `bakery status`, `bakery open`, `bakery logs`, or `bakery stop`. Unless `PI_WEB_WORKSPACE_ROOT` is already set, the launcher uses its invocation directory as the workspace root; use `--workspace /path/to/project` for a different project. The repository script `bun run bakery` remains available for contributor use.

Because Bakery controls an agent that can read, edit, and run shell commands in allowed workspaces, run the launcher only from workspaces you trust. Localhost access keeps the no-token development default; LAN/non-localhost access should be explicit and token-protected.

## Quickstart: local Bun install

For a fuller first-run walkthrough, including workspace safety and the first session, see [`docs/quickstart.md`](docs/quickstart.md).

### 1. Prerequisites

- [Bun](https://bun.sh/) installed.
- A local project directory you are comfortable letting an agent read, edit, and run shell commands inside.
- Usual pi/model provider authentication available to the server process. Bakery uses the published `@earendil-works/pi-coding-agent` SDK and normal pi resources by default.

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

Install the local command from this checkout once:

```bash
npm install -g "$PWD"
```

Then run Bakery from the project you want to use as the workspace:

```bash
cd /path/to/project
bakery
```

To point the command at another project without changing directories, pass the workspace explicitly:

```bash
bakery --workspace /path/to/project
```

Useful local commands while the foreground launcher is running:

```bash
bakery status
bakery open --workspace /path/to/another-project
bakery logs --lines 120
bakery stop
```

Open the printed UI URL, usually:

```text
http://127.0.0.1:5173/
```

The API runs on `http://127.0.0.1:3141`. In localhost-only mode, an auth token is optional; non-localhost requests are rejected unless a token is configured.

Contributors working on Bakery itself can still use the existing detached-backend development loop:

```bash
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev
```

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

Open `http://127.0.0.1:5173/` and use the token from `.env` if prompted. For LAN/Tailscale access, set `PI_WEB_VITE_ALLOWED_HOSTS` and `PI_WEB_PREVIEW_PUBLIC_BASE_URL` in `.env`; see [`docs/container-development.md`](docs/container-development.md#lantailscale-access). The container bind-mounts this repository at `/workspace/bakery`, uses it as the only default workspace root, and mounts `$HOME/.pi` at `/home/bun/.pi` for normal pi auth/resources. Default Compose does not mount Git/GitHub credentials; the image includes `gh`, and [`docs/container-development.md#git-and-github-auth`](docs/container-development.md#git-and-github-auth) covers trusted-dev SSH-agent and GitHub auth override recipes for agents that need fetch, push, or PR tooling inside the container.

Docker socket access is intentionally off by default. When you need Docker commands inside the dev container, opt in explicitly:

```bash
docker compose -f compose.yaml -f compose.docker.yaml up --build
```

See [`docs/container-development.md`](docs/container-development.md) for mounted paths, UID/GID notes, and troubleshooting.

## Common commands

```bash
bun run doctor              # Validate local install readiness
bakery                     # Start the installed foreground Bakery launcher
bun run bakery              # Contributor fallback for the repo-local launcher script
bun run dev                 # Start backend manager, then Vite web UI for development
bun run dev:lan             # Start backend and web UI for token-protected LAN access
bun run dev:server:restart  # Restart only the backend during development
bun run dev:server:logs     # Show backend logs
bun run check               # Typecheck packages/apps and workflow-skill assertions
docker compose up --build   # Run the containerized Bakery development environment
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
| `PI_WEB_VITE_ALLOWED_HOSTS` | unset | Comma-separated hostnames allowed by the Vite dev server for LAN/Tailscale access. |
| `PI_WEB_PREVIEW_PUBLIC_BASE_URL` | unset | Public base URL used when Bakery renders Preview Stack links. |

See `apps/server/src/config.ts` for the full set of server configuration knobs.

## Documentation

Use [`docs/README.md`](docs/README.md) as the durable documentation map. Start with [`docs/quickstart.md`](docs/quickstart.md) for the full first-run path, continue to [`docs/operation.md`](docs/operation.md) for day-to-day safety/runtime diagrams, and use [`docs/troubleshooting.md`](docs/troubleshooting.md) for ports, logs, tokens, validation, and contributor dev-server operation.

## License

Bakery is released under the [MIT License](LICENSE).
