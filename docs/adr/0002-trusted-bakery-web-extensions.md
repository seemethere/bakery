# 0002. Trusted Bakery web extensions use main-document Web Components

Date: 2026-05-01

## Status

Accepted

## Context

Bakery needs extensions to contribute operator-visible browser UI, not only pi runtime commands and tools. Upstream pi extensions are trusted local TypeScript modules that can register commands, tools, message renderers, and TUI components. Bakery should feel similar for backend extension loading, but browser rendering has different constraints: terminal TUI renderers cannot be copied directly into the web transcript, and dynamically loading untrusted browser code would require a heavier sandbox and RPC contract.

The immediate product need is extension-owned transcript cards, starting with `/bakery:generate-details`, while preserving Bakery's local-first security assumptions and keeping the first implementation small enough to dogfood.

## Decision

V1 Bakery web extensions are trusted local code. Bakery loads bundled extensions plus operator-configured additional extension paths using pi-like file, directory, or package entry conventions for backend extension code. Browser UI contributions are declared by the extension and rendered in controlled Bakery slots.

For web UI, an extension may declare a browser-loadable JavaScript module. Bakery serves that module from the local backend and imports it into the main document. The module registers Web Components, and Bakery renders those components only in declared slots such as `transcript.customCard`, passing data through attributes/properties rather than letting extensions patch arbitrary app DOM.

Bakery will not sandbox these v1 web modules in iframes/workers, and it will not transpile browser TypeScript as part of the first slice.

## Alternatives considered

- **Sandbox extension UI in iframes from day one** — stronger isolation and a clearer untrusted-plugin story, but requires message-passing APIs, sizing/focus coordination, style/token plumbing, and more failure modes before the first card can ship.
- **Transpile/browser-bundle extension TypeScript in Bakery** — closer to upstream pi's TypeScript authoring experience, but adds bundling dependency and module-resolution complexity before the UI contribution contract is proven.
- **Keep cards host-owned only** — simplest and safest, but product-specific UI would keep accumulating in the core transcript renderer and extensions would not be true browser UI contributors.
- **Reuse pi TUI renderers directly** — preserves upstream extension rendering semantics, but terminal components do not map cleanly to accessible, responsive browser UI.

## Consequences

- Extension browser code has the same trust level as the local Bakery app page; operators must only load trusted paths.
- Bakery keeps control over layout, mobile behavior, and slot placement while allowing extension-owned card components.
- Extension authors need to provide browser-loadable JavaScript for web UI until a later DX pass adds TypeScript/bundling support.
- Future sandboxing remains possible, but it will require a compatibility layer or a new web extension API version.
- The first reference implementation should migrate `/bakery:generate-details` from a hard-coded transcript card to a `transcript.customCard` contribution.
