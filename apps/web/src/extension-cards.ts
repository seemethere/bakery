import type { ExtensionCatalog, ExtensionCardContribution } from "@pi-web-agent/protocol";
import { escapeHtml, isRecord } from "./utils";

declare global {
  interface Window {
    __bakeryExtensionCardContributions?: Record<string, ExtensionCardContribution>;
  }
}

const loadedModules = new Set<string>();

function absoluteExtensionUrl(apiBase: string, entryUrl: string, token: string): string {
  const url = new URL(entryUrl, apiBase);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export async function loadExtensionCatalog(options: { apiBase: string; token: string; api: <T>(path: string) => Promise<T> }): Promise<ExtensionCatalog> {
  const catalog = await options.api<ExtensionCatalog>("/api/extensions");
  window.__bakeryExtensionCardContributions = Object.fromEntries(catalog.cards.map((card) => [card.kind, card]));
  for (const module of catalog.webModules) {
    const url = absoluteExtensionUrl(options.apiBase, module.entryUrl, options.token);
    if (loadedModules.has(url)) continue;
    await import(/* @vite-ignore */ url);
    loadedModules.add(url);
  }
  return catalog;
}

export function extensionCardPayload(item: { raw?: unknown }): { kind: string; props: unknown } | null {
  if (!isRecord(item.raw) || !isRecord(item.raw.data)) return null;
  const data = item.raw.data;
  if (data.kind !== "extension_card" || !isRecord(data.card) || typeof data.card.kind !== "string") return null;
  return { kind: data.card.kind, props: data.card.props };
}

export function hasExtensionCard(item: { raw?: unknown }): boolean {
  return extensionCardPayload(item) !== null;
}

export function renderExtensionCard(item: { raw?: unknown }): string {
  const payload = extensionCardPayload(item);
  if (!payload) return "";
  const contribution = window.__bakeryExtensionCardContributions?.[payload.kind];
  if (!contribution) {
    return `<article class="metadata-details-card deferred"><div class="metadata-details-card-header"><span class="metadata-details-kicker">Extension card unavailable</span></div><div class="metadata-details-summary">${escapeHtml(payload.kind)}</div></article>`;
  }
  const props = escapeHtml(JSON.stringify(payload.props ?? {}));
  const tag = contribution.component;
  if (!/^[-a-z0-9]+$/.test(tag) || !tag.includes("-")) {
    return `<article class="metadata-details-card deferred"><div class="metadata-details-card-header"><span class="metadata-details-kicker">Invalid extension card component</span></div><div class="metadata-details-summary">${escapeHtml(tag)}</div></article>`;
  }
  return `<${tag} data-extension-id="${escapeHtml(contribution.extensionId)}" data-extension-card-kind="${escapeHtml(payload.kind)}" data-extension-card-props="${props}"></${tag}>`;
}
