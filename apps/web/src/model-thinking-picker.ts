import type { ModelInfo, SessionRuntimeSettings } from "@pi-web-agent/protocol";
import { escapeHtml } from "./utils";

export type ModelThinkingPickerOptions = {
  settings: SessionRuntimeSettings;
  isController: boolean;
  open: boolean;
  defaultThinkingLevel?: string | undefined;
  showThinking?: boolean | undefined;
  includeShowThinking?: boolean | undefined;
  renderPopover?: boolean | undefined;
};

function trimProviderPrefix(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function titleCaseCompact(value: string): string {
  return value
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((part) => /^\d+(?:\.\d+)*$/.test(part) ? part : part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
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

export function modelThinkingTriggerLabel(settings: SessionRuntimeSettings, defaultThinkingLevel?: string | undefined): string {
  const model = modelShorthand(settings.model);
  return isNonDefaultThinkingLevel(settings.thinkingLevel, defaultThinkingLevel) ? `${model} · ${settings.thinkingLevel}` : model;
}

export function renderModelThinkingPopover(options: ModelThinkingPickerOptions): string {
  const { settings, isController, showThinking = false, includeShowThinking = false } = options;
  const currentModelId = settings.model?.id ?? "";
  const disabled = isController ? "" : "disabled";
  return `<div class="model-thinking-popover" role="dialog" aria-label="Model and thinking settings">
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
      ${includeShowThinking ? `<label class="model-thinking-checkbox"><input id="showThinking" type="checkbox" ${showThinking ? "checked" : ""} /> Show thinking in transcript</label>` : ""}
    </div>`;
}

export function renderModelThinkingPicker(options: ModelThinkingPickerOptions): string {
  const { settings, isController, open, defaultThinkingLevel, renderPopover = true } = options;
  const label = modelThinkingTriggerLabel(settings, defaultThinkingLevel);
  const disabled = isController ? "" : "disabled";
  const brainIcon = `<svg class="model-thinking-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5a3 3 0 0 0-3 3 3.2 3.2 0 0 0 .2 1.1A3.5 3.5 0 0 0 7 15.5V17a3 3 0 0 0 5 2.24A3 3 0 0 0 17 17v-1.5a3.5 3.5 0 0 0 .8-6.9A3.2 3.2 0 0 0 18 7.5a3 3 0 0 0-5.2-2.03A3 3 0 0 0 9 4.5Z"/><path d="M12 5.5v14"/><path d="M8.5 9.5H12"/><path d="M12 9.5h3.5"/><path d="M8.5 14H12"/><path d="M12 14h3.5"/></svg>`;
  return `<div class="model-thinking-picker ${open ? "open" : ""}">
    <button id="modelThinkingToggle" class="model-thinking-trigger" type="button" aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}" ${disabled} title="Change model and thinking level">
      ${brainIcon}
      <span class="model-thinking-trigger-label">${escapeHtml(label)}</span>
      <span class="model-thinking-trigger-caret" aria-hidden="true">▾</span>
    </button>
    ${open && renderPopover ? renderModelThinkingPopover(options) : ""}
  </div>`;
}
