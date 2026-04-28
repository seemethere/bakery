import type { ModelInfo, SessionRuntimeSettings } from "@pi-web-agent/protocol";
import { escapeHtml } from "./utils";

export type ModelThinkingPickerOptions = {
  settings: SessionRuntimeSettings;
  isController: boolean;
  open: boolean;
  defaultThinkingLevel?: string | undefined;
};

function trimProviderPrefix(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function titleCaseCompact(value: string): string {
  return value
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
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
  const base = trimProviderPrefix(modelDisplayName(model))
    .replace(/\bclaude[-\s]*/i, "")
    .replace(/\bchatgpt[-\s]*/i, "")
    .replace(/\bgpt[-\s]*/i, "GPT-")
    .replace(/\s+/g, " ")
    .trim();
  return titleCaseCompact(base || modelDisplayName(model)).replace(/\bGPT (\d)/g, "GPT-$1");
}

export function isNonDefaultThinkingLevel(level: string, defaultThinkingLevel?: string | undefined): boolean {
  const defaultLevel = defaultThinkingLevel?.trim() || "medium";
  return Boolean(level) && level !== defaultLevel;
}

export function modelThinkingTriggerLabel(settings: SessionRuntimeSettings, defaultThinkingLevel?: string | undefined): string {
  const model = modelShorthand(settings.model);
  return isNonDefaultThinkingLevel(settings.thinkingLevel, defaultThinkingLevel) ? `${model} · ${settings.thinkingLevel}` : model;
}

export function renderModelThinkingPicker(options: ModelThinkingPickerOptions): string {
  const { settings, isController, open, defaultThinkingLevel } = options;
  const currentModelId = settings.model?.id ?? "";
  const label = modelThinkingTriggerLabel(settings, defaultThinkingLevel);
  const disabled = isController ? "" : "disabled";
  return `<div class="model-thinking-picker ${open ? "open" : ""}">
    <button id="modelThinkingToggle" class="model-thinking-trigger" type="button" aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}" ${disabled} title="Change model and thinking level">
      <span class="model-thinking-trigger-label">${escapeHtml(label)}</span>
      <span class="model-thinking-trigger-caret" aria-hidden="true">▾</span>
    </button>
    ${open ? `<div class="model-thinking-popover" role="dialog" aria-label="Model and thinking settings">
      <label>Model
        <select id="model" ${disabled}>
          ${settings.availableModels.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === currentModelId ? "selected" : ""}>${escapeHtml(modelOptionLabel(model))}</option>`).join("")}
        </select>
      </label>
      <label>Thinking
        <select id="thinking" ${disabled}>
          ${settings.availableThinkingLevels.map((level) => `<option value="${escapeHtml(level)}" ${level === settings.thinkingLevel ? "selected" : ""}>${escapeHtml(level)}</option>`).join("")}
        </select>
      </label>
    </div>` : ""}
  </div>`;
}
