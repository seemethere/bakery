# First-run quickstart

This guide takes a new technical operator from a fresh checkout to a first safe local Bakery session. It keeps the primary path local and Bun-based; use the [containerized development guide](container-development.md) only when you specifically want Docker for Bakery development or a more bounded dev environment.

## 1. Choose a safe workspace

Bakery starts coding-agent sessions that can read files, edit files, and run shell commands in approved workspaces. Start with a repository or project directory you trust, and keep the workspace boundary narrow.

Good first choices:

- A single project checkout you are comfortable modifying.
- A disposable test repository.
- This Bakery checkout, if you are developing Bakery itself.

Avoid broad roots such as your whole home directory for first use.

## 2. Install prerequisites

You need:

- [Bun](https://bun.sh/) installed.
- Model/provider credentials available to the backend process through normal pi mechanisms, such as environment variables or `~/.pi/agent/auth.json`.
- This repository checked out locally.

Install dependencies from the repository root:

```bash
bun install
```

## 3. Check the local setup

Run the doctor before starting Bakery:

```bash
bun run doctor
```

The doctor checks Bun, dependencies, writable data/workspace directories, likely port conflicts, and whether the current host/token settings are safe for local mode.

If you plan to expose Bakery beyond localhost, stop here and read [local network access](local-network.md) first. LAN mode should use an explicit token.

## 4. Start Bakery locally

For the current source-checkout launcher prototype, run:

```bash
bun run bakery
```

The launcher starts the local backend and Vite web UI as foreground child processes, prints the local UI/API URLs, and uses the invocation directory as the workspace root unless `PI_WEB_WORKSPACE_ROOT` is already set.

To point Bakery at a different project while running the launcher from this repository, set the workspace explicitly:

```bash
PI_WEB_WORKSPACE_ROOT=/path/to/project bun run bakery
```

Open the printed UI URL, usually:

```text
http://127.0.0.1:5173/
```

Press `Ctrl+C` in the launcher terminal to stop both child processes.

## 5. Create the first session

In the browser:

1. Confirm the workspace shown by Bakery is the project you intended to trust.
2. Use **New session** to start a session in that workspace.
3. Send a small prompt, or start with `/plan` when you want Bakery to interview you before implementation.

A Bakery Agent Session is server-backed. Multiple browser tabs can view the same session, but the session is not the same thing as a tab.

## 6. Know the safe defaults

- Localhost use can run without a token.
- Non-localhost/LAN access requires an explicit token.
- Session working directories must be inside configured Browse Roots or Approved Workspaces.
- The backend owns model credentials; the browser should not store provider API keys.
- In-flight agent turns are not recovered after a backend restart in the first version.

## 7. Next docs

- [Operating Bakery safely](operation.md) for day-to-day workspace/session/auth behavior and runtime diagrams.
- [Local network access](local-network.md) for phone, tablet, LAN, or Tailscale use.
- [Containerized development](container-development.md) for Docker-based Bakery development.
- Troubleshooting guide for ports, logs, tokens, and contributor dev-server operation once added.
- [Documentation map](README.md) for architecture, ADRs, extension design, and vocabulary.
