# Containerized development

Bakery's containerized development environment runs the existing Bun/Vite development workflow inside Docker while bind-mounting this checkout as the only default Bakery workspace.

This is for developing Bakery itself. It is not yet the production single-port image, the future multi-backend `bakery` CLI, or per-agent-session container isolation.

## Start the dev container

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`:

   - Set `PI_WEB_AUTH_TOKEN` to a non-shared local secret.
   - On Linux, set `PI_WEB_CONTAINER_UID` and `PI_WEB_CONTAINER_GID` to your host ids:

     ```bash
     id -u
     id -g
     ```

3. Build and run Bakery:

   ```bash
   docker compose up --build
   ```

4. Open the Vite dev UI from the host browser:

   ```text
   http://127.0.0.1:5173/
   ```

   The API runs at `http://127.0.0.1:3141`. Enter the same `PI_WEB_AUTH_TOKEN` from `.env` if the app asks for a token.

## What is mounted

| Host path | Container path | Purpose |
| --- | --- | --- |
| `.` | `/workspace/bakery` | This Bakery checkout and the only default allowed workspace root. |
| `$HOME/.pi` | `/home/bun/.pi` | Existing pi auth, resources, and configuration. Mounted read-write for compatibility with normal pi behavior. |
| `bakery-node-modules` volume | `/workspace/bakery/node_modules` | Container-owned dependencies so host `node_modules` is not required. |
| `bakery-data` volume | `/workspace/.bakery-data` | Bakery metadata, session files, artifacts, and managed worktrees for the container. |
| `bakery-bun-cache` volume | `/workspace/.cache/bun` | Bun cache for faster reinstalls. |

The entrypoint starts as root only long enough to map the container user to `PI_WEB_CONTAINER_UID`/`PI_WEB_CONTAINER_GID`, prepare writable volumes, and then drop privileges before running Bakery.

## Docker socket access

Docker access from inside the Bakery dev container is intentionally opt-in because mounting `/var/run/docker.sock` effectively grants host-level Docker control.

When you need agents or commands inside the container to run Docker, use the override file explicitly:

```bash
docker compose -f compose.yaml -f compose.docker.yaml up --build
```

Without `compose.docker.yaml`, the Docker CLI is present in the image but cannot talk to the host daemon.

## Common commands

```bash
docker compose up --build                         # Start backend + Vite in the container
docker compose down                               # Stop the container, keep named volumes
docker compose down -v                            # Stop and remove dependency/data volumes
docker compose run --rm bakery-dev bun run check  # Run checks inside the container
```

Use the same `--env-file` or `.env` settings for these commands if you do not keep a root `.env` file.

## Validation for future changes

When modifying the containerized development environment, validate from the smallest relevant layer upward. Start with the repository's validation selector and stop to fix the first failure.

1. Ask the validation selector for the changed files:

   ```bash
   bun run report:iteration --recommend Dockerfile docker/entrypoint.sh .dockerignore compose.yaml compose.docker.yaml .env.example README.md docs/container-development.md CONTEXT.md
   ```

   Pass only the files you changed when the slice is narrower. Include the selector's `## Validation decision` block in the handoff.

2. Run the static project check selected for Docker/docs-only changes:

   ```bash
   bun run check
   ```

3. Rebuild the dev image when `Dockerfile`, `.dockerignore`, or entrypoint behavior changed:

   ```bash
   docker build -t bakery-dev:local .
   ```

4. Smoke the entrypoint, host UID/GID mapping, and bind-mount ownership when entrypoint, user, mount, or image-package behavior changed:

   ```bash
   rm -rf test-results/container-smoke
   mkdir -p test-results/container-smoke

   docker run --rm \
     -e PI_WEB_CONTAINER_UID="$(id -u)" \
     -e PI_WEB_CONTAINER_GID="$(id -g)" \
     -v "$PWD:/workspace/bakery" \
     bakery-dev:local \
     bash -lc 'id && bun --version && git --version && docker --version && touch test-results/container-smoke/ownership.txt'

   ls -ln test-results/container-smoke/ownership.txt
   ```

   Confirm the owner/group match the host UID/GID.

5. Validate Compose wiring when Compose, env, ports, volumes, or docs changed:

   ```bash
   docker compose --env-file .env.example config
   ```

6. Smoke the full backend + Vite dev flow when Compose startup or runtime environment changed:

   ```bash
   docker compose --env-file .env.example up --build -d

   curl -fsS \
     -H 'Authorization: Bearer change-me' \
     http://127.0.0.1:3141/healthz

   curl -fsS http://127.0.0.1:5173/ | head

   docker compose --env-file .env.example down
   ```

7. Validate Docker socket access only when Docker CLI, entrypoint socket-group logic, or `compose.docker.yaml` changed:

   ```bash
   docker compose \
     -f compose.yaml \
     -f compose.docker.yaml \
     --env-file .env.example \
     run --rm --no-deps bakery-dev \
     bash -lc 'docker version --format "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"'
   ```

8. Do a manual browser smoke for meaningful dev-flow changes:

   ```bash
   cp .env.example .env
   # Edit .env: set PI_WEB_AUTH_TOKEN; on Linux set PI_WEB_CONTAINER_UID/GID.
   docker compose up --build
   ```

   Open `http://127.0.0.1:5173/`, enter the token from `.env`, and confirm Bakery can list or create sessions against `/workspace/bakery`.

Do not run full `bun run test:web-perf` by default for Docker/docs-only changes. Escalate to focused UI harnesses or the full fake-agent suite only when the change also touches browser UI behavior, protocol/session lifecycle, server runtime behavior beyond container configuration, auth/CORS/API behavior, or when a focused Docker/manual smoke fails in a way that suggests an app-level regression.

## Troubleshooting

### Compose says `PI_WEB_AUTH_TOKEN` is missing

Copy `.env.example` to `.env` and set `PI_WEB_AUTH_TOKEN` to a local secret. Bakery rejects non-localhost API access without a token, and container networking can make requests appear non-local from the backend's point of view.

### Files are created with the wrong owner on Linux

Set these values in `.env`:

```env
PI_WEB_CONTAINER_UID=<output of id -u>
PI_WEB_CONTAINER_GID=<output of id -g>
```

Then recreate the container:

```bash
docker compose down
docker compose up --build
```

### Ports are already in use

Change the host-side ports in `.env`:

```env
PI_WEB_PORT=43141
PI_WEB_WEB_PORT=45173
```

The container still listens on `3141` and `5173`; only the host bindings change.

### The app cannot access model credentials or pi resources

Confirm `$HOME/.pi` exists on the host and is mounted at `/home/bun/.pi` in the container. The default mount is read-write to preserve normal pi auth/resource behavior.

### Docker commands fail inside the container

Use the explicit Docker socket override:

```bash
docker compose -f compose.yaml -f compose.docker.yaml run --rm bakery-dev docker version
```

If that works, restart the full dev environment with the same two `-f` files.
