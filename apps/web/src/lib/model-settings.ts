import type { ContextUsage, ModelInfo, SessionRuntimeSettings } from "@pi-web-agent/protocol";

function trimProviderPrefix(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function titleCaseCompact(value: string): string {
  return value
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((part) => (/^\d+(?:\.\d+)*$/.test(part) ? part : part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

export function modelDisplayName(model: ModelInfo): string {
  return model.name?.trim() || trimProviderPrefix(model.id) || model.id;
}

export function modelOptionLabel(model: ModelInfo): string {
  return `${modelDisplayName(model)} [${model.provider}]`;
}

export function modelShorthand(model: ModelInfo | null | undefined): string {
  if (!model) return "Model";
  const decimalPlaceholder = "__PI_DECIMAL__";
  const base = trimProviderPrefix(modelDisplayName(model))
    .replace(/(\d)\.(\d)/g, `$1${decimalPlaceholder}$2`)
    .replace(/\bclaude[-\s]*/i, "")
    .replace(/\bchatgpt[-\s]*/i, "")
    .replace(/\bgpt[-\s]*/i, "GPT ")
    .replace(/\./g, " ")
    .replace(new RegExp(decimalPlaceholder, "g"), ".")
    .replace(/\s+/g, " ")
    .trim();
  return titleCaseCompact(base || modelDisplayName(model));
}

export function isNonDefaultThinkingLevel(level: string, defaultThinkingLevel?: string | undefined): boolean {
  const defaultLevel = defaultThinkingLevel?.trim() || "medium";
  return Boolean(level) && level !== defaultLevel;
}

export function modelThinkingLabel(settings: SessionRuntimeSettings, defaultThinkingLevel?: string | undefined): string {
  const model = modelShorthand(settings.model);
  return isNonDefaultThinkingLevel(settings.thinkingLevel, defaultThinkingLevel) ? `${model} · ${settings.thinkingLevel}` : model;
}

export function contextUsagePercentLabel(usage: ContextUsage): string {
  if (usage.percent === null) return "unknown";
  return `${usage.percent.toFixed(1)}%`;
}

export function contextUsageLabel(usage: ContextUsage): string {
  if (usage.tokens === null && usage.percent === null && usage.contextWindow === 1) return "unknown";
  const tokens = usage.tokens === null ? "unknown" : formatTokenCount(usage.tokens);
  return `${tokens} / ${formatTokenCount(usage.contextWindow)} (${contextUsagePercentLabel(usage)})`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}
