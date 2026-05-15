# Containerized development

Bakery's containerized development environment runs the existing Bun/Vite development workflow inside Docker while bind-mounting this checkout as the only default Bakery workspace.

This is for developing Bakery itself. It is not yet the production single-port image, the future multi-backend `bakery` CLI, or per-agent-session container isolation. If you are trying Bakery for the first time without Docker-specific needs, start with the [first-run quickstart](quickstart.md); for general ports, logs, tokens, and validation recovery, see [troubleshooting and developer operation](troubleshooting.md).

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
| `$HOME/.pi` | `/home/bun/.pi` | Existing pi auth, resources, configuration, and pi JSONL session logs. Mounted read-write for compatibility with normal pi behavior. The entrypoint points `PI_CODING_AGENT_DIR` at a container-local overlay under `/workspace/.bakery-data/pi-agent` that symlinks this config but keeps managed binaries (`fd`, `rg`) Linux-native, avoiding host macOS/Windows binaries from `~/.pi/agent/bin`. Compose sets `PI_WEB_SESSION_DIR=/home/bun/.pi/agent/sessions` so iteration telemetry can discover these logs. |
| `bakery-node-modules` volume | `/workspace/bakery/node_modules` | Container-owned dependencies so host `node_modules` is not required. |
| `bakery-data` volume | `/workspace/.bakery-data` | Bakery metadata, session files, artifacts, and managed worktrees for the container. |
| `bakery-bun-cache` volume | `/workspace/.cache/bun` | Bun cache for faster reinstalls. |

The image includes the Linux runtime libraries and fonts required by Playwright's bundled Chromium/headless shell, so UI harnesses can run inside the dev container after the usual `bun install` and `bun x playwright install chromium` browser download. The entrypoint starts as root only long enough to map the container user to `PI_WEB_CONTAINER_UID`/`PI_WEB_CONTAINER_GID`, prepare writable volumes, and then drop privileges before running Bakery.

The pi settings overlay keeps host auth/model/resource settings but filters known Bun-incompatible npm packages from container startup by default. Today this excludes `npm:@howaboua/pi-codex-conversion` because it imports `node-pty`, which can crash Bun in the in-process SDK server. Set `PI_WEB_CONTAINER_EXCLUDED_PACKAGES=` in a trusted local override to opt back into exact host package settings, but expect native Node packages to require the included build toolchain and to remain unsupported if Bun cannot load their native modules.

## LAN/Tailscale access

The dev container can replace a host-side LAN command such as:

```bash
PI_WEB_VITE_ALLOWED_HOSTS=bakery-dev.example.ts.net \
PI_WEB_PREVIEW_PUBLIC_BASE_URL=http://bakery-dev.example.ts.net \
bun run dev:lan
```

Set the same values in `.env` instead:

```env
PI_WEB_AUTH_TOKEN=your-local-secret
PI_WEB_VITE_ALLOWED_HOSTS=bakery-dev.example.ts.net
PI_WEB_PREVIEW_PUBLIC_BASE_URL=http://bakery-dev.example.ts.net
```

Then start Bakery normally:

```bash
docker compose up --build
```

Open the Vite UI at `http://bakery-dev.example.ts.net:5173/` and use the token from `.env` if prompted. `PI_WEB_VITE_ALLOWED_HOSTS` is the hostname only, while `PI_WEB_PREVIEW_PUBLIC_BASE_URL` includes the scheme. Bakery replaces the preview base URL's port with each Preview Stack's allocated port.

Compose publishes the main Bakery ports (`3141` and `5173`) by default. Preview Stacks allocate dynamic ports inside the container, so preview URLs may still need a future explicit preview port-range publishing slice before they are reachable from the host/LAN browser.

## Docker socket access

Docker access from inside the Bakery dev container is intentionally opt-in because mounting `/var/run/docker.sock` effectively grants host-level Docker control.

When you need agents or commands inside the container to run Docker, use the override file explicitly:

```bash
docker compose -f compose.yaml -f compose.docker.yaml up --build
```

Without `compose.docker.yaml`, the Docker CLI is present in the image but cannot talk to the host daemon.

## Git and GitHub auth

Bakery piggybacks on the Git and GitHub credentials available to the backend process. In a local Bun run, the backend is your normal host process, so agents inherit the same practical auth surface as the terminal that launched Bakery: repository and global Git config, credential helpers, SSH agent environment, `gh` auth when `gh` is installed, and any exported `GH_TOKEN`/`GITHUB_TOKEN` values.

The Compose dev container intentionally does **not** inherit host Git/GitHub auth by default. The default mounts do not include `$HOME/.gitconfig`, `$HOME/.ssh`, `$HOME/.config/gh`, Git credential stores, broad `$HOME` paths, or SSH agent sockets. This keeps the safe default narrow: worktree creation can use local repository metadata, but remote operations such as `git fetch`, `git push`, or PR creation require credentials that are explicitly available inside the container.

Treat any Git/GitHub auth setup for the dev container as a trusted-local-development opt-in. Credentials exposed to the container are also available to agent commands running in that container.

### Recommended path: forward an SSH agent

Prefer forwarding an existing host SSH agent when feasible. This avoids mounting private key files or long-lived GitHub tokens directly into the container. Bakery includes `compose.ssh-auth.example.yaml` as an opt-in override for host agents whose socket is available through `$SSH_AUTH_SOCK`:

```bash
docker compose -f compose.yaml -f compose.ssh-auth.example.yaml up --build
```

If the host socket path is unset or does not exist, Docker Compose will fail before starting the container. Only add bind mounts for paths that exist on your host. The entrypoint adds the mapped container user to the mounted socket's group when possible, which helps with host sockets that are group-readable but not world-readable.

Docker Desktop for macOS may expose the agent at `/run/host-services/ssh-auth.sock` instead of the shell's `$SSH_AUTH_SOCK`; bind-mounting the shell socket can fail with `Connection refused`. In that case, copy the example to a private local override and use `/run/host-services/ssh-auth.sock` for both `SSH_AUTH_SOCK` and the bind mount source/target.

### GitHub CLI auth

The dev image includes GitHub CLI (`gh`). It still does not receive GitHub credentials unless you opt in. Bakery includes `compose.gh-auth.example.yaml` to mount an existing host `${HOME}/.config/gh` read-only. This reuses `gh auth login` state when the host config format is portable to the Linux container. The example uses `create_host_path: false` so Compose fails instead of creating an empty credential directory when the host path is missing.

Start with the GitHub auth override when you need existing `gh` login state inside Bakery sessions:

```bash
docker compose -f compose.yaml -f compose.gh-auth.example.yaml up --build
```

Combine both overrides when you want SSH Git remotes and `gh` in the same container:

```bash
docker compose \
  -f compose.yaml \
  -f compose.ssh-auth.example.yaml \
  -f compose.gh-auth.example.yaml \
  up --build
```

### Other trusted-dev options

Use these only when they match your local security tradeoff:

- Pass `GH_TOKEN` or `GITHUB_TOKEN` from a private Compose override or shell you control. This is simple and CI-like, but the token is available to commands and agents inside the container. Avoid putting real tokens in checked-in files, shell history, shared logs, or transcripts.
- Mount Git identity/settings read-only, for example `${HOME}/.gitconfig:/home/bun/.gitconfig:ro`. This can provide `user.name`, `user.email`, aliases, and URL rewrites, but it is not the same as remote auth. Host configs may reference helpers or include paths that do not exist in a Linux container, such as `osxkeychain`, GPG signing tools, 1Password helpers, or absolute host paths.
- Mount SSH configuration and keys read-only, for example `${HOME}/.ssh:/home/bun/.ssh:ro`, only for trusted local development. This exposes private key material to any command or agent running in the container; prefer SSH agent forwarding when possible.

Keep auth mounts separate from workspace roots. Do not expand `PI_WEB_WORKSPACE_ROOT` just to make credentials visible; session working directories should stay under the intended repository/workspace allowlist.

### Safe verification commands

Verify configuration from inside the container without printing secrets:

```bash
docker compose run --rm bakery-dev bash -lc '
  git --version
  ssh -V
  gh --version
  git config --global --get user.name || true
  git config --global --get user.email || true
  ssh-add -l || true
  gh auth status || true
'
```

For actual remote auth, use harmless remote reads against repositories you can access:

```bash
docker compose -f compose.yaml -f compose.ssh-auth.example.yaml run --rm bakery-dev \
  bash -lc 'git ls-remote git@github.com:<owner>/<repo>.git HEAD'

docker compose -f compose.yaml -f compose.gh-auth.example.yaml run --rm bakery-dev \
  bash -lc 'gh repo view <owner>/<repo> --json nameWithOwner --jq .nameWithOwner'
```

Do not verify by echoing tokens, printing private keys, dumping credential-store files, or mounting broad home directories.

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
   bun run report:iteration --recommend Dockerfile docker/entrypoint.sh .dockerignore compose.yaml compose.docker.yaml compose.ssh-auth.example.yaml compose.gh-auth.example.yaml .env.example README.md docs/container-development.md CONTEXT.md
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

4. Smoke the entrypoint, host UID/GID mapping, host socket group handling, and bind-mount ownership when entrypoint, user, mount, or image-package behavior changed:

   ```bash
   rm -rf test-results/container-smoke
   mkdir -p test-results/container-smoke

   docker run --rm \
     -e PI_WEB_CONTAINER_UID="$(id -u)" \
     -e PI_WEB_CONTAINER_GID="$(id -g)" \
     -v "$PWD:/workspace/bakery" \
     bakery-dev:local \
     bash -lc 'id && bun --version && git --version && gh --version && rg --version && command -v fd && test "$(command -v fd)" = /usr/local/bin/fd && test -L "${PI_CODING_AGENT_DIR}/bin/fd" && test -L "${PI_CODING_AGENT_DIR}/bin/rg" && fd --version && docker --version && touch test-results/container-smoke/ownership.txt'

   ls -ln test-results/container-smoke/ownership.txt
   ```

   Confirm the owner/group match the host UID/GID.

5. Smoke Playwright/Chromium launch when browser runtime packages changed:

   ```bash
   docker run --rm \
     -e PI_WEB_CONTAINER_UID="$(id -u)" \
     -e PI_WEB_CONTAINER_GID="$(id -g)" \
     -v "$PWD:/workspace/bakery" \
     bakery-dev:local \
     bash -lc 'bun install && bun x playwright install chromium && bun -e "const { chromium } = require(\"playwright\"); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.setContent(\"<h1>ok</h1>\"); console.log(await page.textContent(\"h1\")); await browser.close();"'
   ```

   This validates the image's system libraries; the Chromium browser binary itself is still downloaded by Playwright into the container/user cache rather than baked into the image.

6. Validate Compose wiring when Compose, env, ports, volumes, or docs changed:

   ```bash
   docker compose --env-file .env.example config
   docker compose -f compose.yaml -f compose.ssh-auth.example.yaml --env-file .env.example config
   docker compose -f compose.yaml -f compose.gh-auth.example.yaml --env-file .env.example config
   ```

   The SSH override requires `SSH_AUTH_SOCK` to reference an existing host socket. Skip that specific override config check only when no host SSH agent is available.

7. Smoke the full backend + Vite dev flow when Compose startup or runtime environment changed:

   ```bash
   docker compose --env-file .env.example up --build -d

   curl -fsS \
     -H 'Authorization: Bearer change-me' \
     http://127.0.0.1:3141/healthz

   curl -fsS http://127.0.0.1:5173/ | head

   docker compose --env-file .env.example down
   ```

8. Validate Docker socket access only when Docker CLI, entrypoint socket-group logic, or `compose.docker.yaml` changed:

   ```bash
   docker compose \
     -f compose.yaml \
     -f compose.docker.yaml \
     --env-file .env.example \
     run --rm --no-deps bakery-dev \
     bash -lc 'docker version --format "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"'
   ```

9. Do a manual browser smoke for meaningful dev-flow changes:

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

### Iteration telemetry cannot find pi session logs

Compose sets `PI_WEB_SESSION_DIR=/home/bun/.pi/agent/sessions`, matching the mounted pi default. If you override this value or run outside Compose, point it at the directory that contains pi JSONL session logs; `bun run report:iteration --session-context` scans nested cwd-specific subdirectories under that path.

### Playwright says host system dependencies are missing

Rebuild the dev image so the Playwright Chromium runtime packages from `Dockerfile` are installed:

```bash
docker compose down
docker compose up --build
```

Inside the rebuilt container, rerun the browser install/launch smoke:

```bash
bun x playwright install chromium
bun -e 'const { chromium } = require("playwright"); const browser = await chromium.launch({ headless: true }); await browser.close(); console.log("chromium ok");'
```

### SSH agent forwarding fails inside the container

First confirm the host has an agent and at least one loaded identity:

```bash
ssh-add -l
```

Then confirm the same override is used for the dev container command:

```bash
docker compose -f compose.yaml -f compose.ssh-auth.example.yaml run --rm bakery-dev ssh-add -l
```

If this fails with `Connection refused` on Docker Desktop for macOS, use Docker Desktop's `/run/host-services/ssh-auth.sock` socket in a private override instead of bind-mounting the shell's `$SSH_AUTH_SOCK` path.

### GitHub CLI auth fails inside the container

The image includes `gh`, but the default Compose stack still does not expose GitHub credentials. Use `compose.gh-auth.example.yaml` only when `${HOME}/.config/gh` exists and `gh auth status` works on the host, or pass a token from a private override. If the mounted host auth is expired or invalid, fix it on the host with `gh auth login` before retrying in the container.

### Docker commands fail inside the container

Use the explicit Docker socket override:

```bash
docker compose -f compose.yaml -f compose.docker.yaml run --rm bakery-dev docker version
```

If that works, restart the full dev environment with the same two `-f` files.
