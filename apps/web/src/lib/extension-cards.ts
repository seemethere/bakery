import type { ExtensionCardContribution, ExtensionCatalog } from "@pi-web-agent/protocol";

declare global {
  interface Window {
    __bakeryExtensionCardContributions?: Record<string, ExtensionCardContribution>;
  }
}

const loadedModules = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
