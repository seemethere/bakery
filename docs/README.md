# Bakery documentation

Use this map to choose the shortest useful path through the Bakery docs. If you are new to Bakery, start with the root [README](../README.md), then continue to the quickstart and operation guides as needed.

## Start here

- [Root README](../README.md) — shortest overview, local install commands, and links to the rest of the docs.
- [First-run quickstart](quickstart.md) — clone-to-first-session walkthrough with local Bun as the primary route.
- Operation guide — planned day-to-day guide for workspaces, sessions, auth, and safe local use.
- Troubleshooting guide — planned command map and recovery guide for ports, tokens, logs, and contributor dev-server operation.

## Run Bakery from another device

- [Local network access](local-network.md) — token-protected LAN/Tailscale setup after local mode works.
- [Remote screenshot artifact uploads](remote-artifacts.md) — helper flow for uploading screenshots from another machine into a running Bakery session.

## Develop Bakery in a container

- [Containerized development](container-development.md) — Docker Compose setup for developing Bakery itself in a container, including mounted paths, auth options, Playwright notes, and validation expectations.

## Understand the product and architecture

- [Design](../DESIGN.md) — target architecture, security model, protocol shape, and feature checklist.
- [Extension architecture](extensions-design.md) — current design for bundled and trusted local Bakery extensions.
- [Codebase and iteration efficiency audit](codebase-efficiency-audit.md) — current code organization and dev-loop improvement notes.

## Vocabulary and decisions

- [Product context](../CONTEXT.md) — shared Bakery domain vocabulary such as Workspace, Browse Root, Approved Workspace, Workflow Command, and Plan Card.
- [Context document format](../CONTEXT-FORMAT.md) — rules for updating domain vocabulary docs.
- [ADR format](../ADR-FORMAT.md) — when and how to record architecture decisions.
- [Architecture decision records](adr/) — accepted decisions that are surprising or tradeoff-driven enough to preserve.

## Documentation maintenance notes

- Keep `PROJECT_LOG.md` as a handoff ledger, not the primary documentation index.
- Prefer durable docs here once a setup path or decision becomes stable.
- Keep quickstart material short and text-only while the UI is still changing quickly.
- Use Mermaid diagrams in operation or troubleshooting docs when they explain runtime flow or safety boundaries better than prose.
