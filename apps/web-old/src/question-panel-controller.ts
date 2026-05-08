import type { PendingQuestion } from "@pi-web-agent/protocol";
import { escapeHtml } from "./utils";

export type QuestionAnswerPayload = { answer?: string; selectedIndex?: number | null; wasCustom?: boolean; cancelled?: boolean };

export type QuestionPanelContext = {
  pendingQuestion: () => PendingQuestion | null;
  isController: () => boolean;
  isConnected: () => boolean;
  isSubmitting: () => boolean;
  root: () => ParentNode;
  answer: (payload: QuestionAnswerPayload) => void;
  setNotice: (notice: string) => void;
  render: () => void;
};

export function canAnswerPendingQuestion(ctx: Pick<QuestionPanelContext, "pendingQuestion" | "isController" | "isConnected" | "isSubmitting">): boolean {
  return Boolean(ctx.pendingQuestion() && ctx.isController() && ctx.isConnected() && !ctx.isSubmitting());
}

export function recommendedQuestionOptionIndex(question: PendingQuestion | null): number {
  if (!question) return -1;
  if (typeof question.recommendedOptionIndex === "number" && question.recommendedOptionIndex >= 0 && question.recommendedOptionIndex < question.options.length) {
    return question.recommendedOptionIndex;
  }
  const recommendation = question.recommendation?.toLowerCase() ?? "";
  if (!recommendation) return -1;
  return question.options.findIndex((option) => {
    const label = option.label.toLowerCase();
    return Boolean(label && recommendation.includes(label));
  });
}


export function focusQuestionPanel(ctx: Pick<QuestionPanelContext, "pendingQuestion" | "root">): void {
  const root = ctx.root();
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-question-option-index]:not(:disabled)"));
  if (buttons.length > 0) {
    const recommendedIndex = recommendedQuestionOptionIndex(ctx.pendingQuestion());
    const target = recommendedIndex >= 0 ? buttons.find((button) => Number(button.dataset.questionOptionIndex ?? "-1") === recommendedIndex) : buttons[0];
    (target ?? buttons[0])?.focus();
    return;
  }
  root.querySelector<HTMLElement>(".question-card.pending")?.focus();
}

export function handleQuestionPanelKeydown(ctx: QuestionPanelContext, event: KeyboardEvent): void {
  const question = ctx.pendingQuestion();
  if (!question) return;
  const buttons = Array.from(ctx.root().querySelectorAll<HTMLButtonElement>("[data-question-option-index]:not(:disabled)"));
  if (buttons.length === 0) return;
  const recommendedIndex = recommendedQuestionOptionIndex(question);
  if (event.key === "Enter" && recommendedIndex >= 0) {
    const option = question.options[recommendedIndex];
    if (option && canAnswerPendingQuestion(ctx)) {
      event.preventDefault();
      ctx.answer({ answer: option.label, selectedIndex: recommendedIndex, wasCustom: false });
    }
  } else if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    const option = question.options[index];
    if (option && canAnswerPendingQuestion(ctx)) {
      event.preventDefault();
      ctx.answer({ answer: option.label, selectedIndex: index, wasCustom: false });
    }
  }
}

export function bindQuestionPanel(ctx: QuestionPanelContext): void {
  const root = ctx.root();
  const card = root.querySelector<HTMLElement>(".question-card.pending");
  if (!card || card.dataset.questionBound === "true") return;
  card.dataset.questionBound = "true";
  card.addEventListener("keydown", (event) => handleQuestionPanelKeydown(ctx, event));
  card.querySelectorAll<HTMLButtonElement>("[data-question-option-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.questionOptionIndex ?? "-1");
      const option = ctx.pendingQuestion()?.options[index];
      if (option && index >= 0 && canAnswerPendingQuestion(ctx)) ctx.answer({ answer: option.label, selectedIndex: index, wasCustom: false });
    });
  });
}

export function renderQuestionPanel(question: PendingQuestion | null, isController: boolean, isConnected: boolean, isSubmitting = false): string {
  if (!question) return "";
  const disabled = !isController || !isConnected || isSubmitting;
  const viewerCopy = isSubmitting
    ? `<p class="question-viewer-copy">Submitting answer…</p>`
    : !isController
      ? `<p class="question-viewer-copy">Take control to answer this question.</p>`
      : !isConnected
        ? `<p class="question-viewer-copy">Reconnect before answering.</p>`
        : "";
  const recommendedOptionIndex = recommendedQuestionOptionIndex(question);
  return `
      <section class="question-card pending${isSubmitting ? " is-submitting" : ""}" aria-label="Answer needed" tabindex="-1" data-question-id="${escapeHtml(question.id)}" aria-busy="${isSubmitting ? "true" : "false"}">
        <div class="question-card-header question-panel-heading">
          <span class="question-card-kicker">Answer needed</span>
          ${question.title ? `<span>${escapeHtml(question.title)}</span>` : `<span>Choose how to continue</span>`}
        </div>
        <p class="question-text">${escapeHtml(question.question)}</p>
        ${question.recommendation && recommendedOptionIndex < 0 ? `<p class="question-recommendation"><b>Recommended:</b> ${escapeHtml(question.recommendation)}</p>` : ""}
        ${question.options.length ? `<div class="question-options" role="listbox" aria-label="Answer options. Use arrow keys to choose, then Enter.">
          ${question.options.map((option, index) => {
            const recommended = index === recommendedOptionIndex;
            return `<button type="button" data-question-option-index="${index}" class="${recommended ? "recommended-option" : ""}" aria-keyshortcuts="${index + 1}" aria-label="${recommended ? "Recommended option: " : ""}${index + 1}. ${escapeHtml(option.label)}" ${disabled ? "disabled" : ""}>
              <span class="option-title"><span class="option-label"><strong>${escapeHtml(option.label)}</strong>${recommended ? `<em>Recommended</em>` : ""}</span><kbd class="option-shortcut">${index + 1}</kbd></span>
              ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
            </button>`;
          }).join("")}
        </div>` : ""}
        <div class="question-actions">
          ${viewerCopy}
          <span class="question-key-hint">Choose with <kbd>1-9</kbd>${recommendedOptionIndex >= 0 ? ` · recommended <kbd>Enter</kbd>` : ""}. Or reply normally in the composer.</span>
          <span class="question-touch-hint">Reply below or tap an option.</span>
        </div>
      </section>`;
}
