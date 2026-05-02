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

export function expandCustomQuestionAnswer(ctx: Pick<QuestionPanelContext, "root">): void {
  const root = ctx.root();
  root.querySelector<HTMLElement>(".question-custom")?.classList.remove("is-collapsed");
  root.querySelector<HTMLElement>(".question-custom")?.classList.add("is-expanded");
  root.querySelector<HTMLInputElement>("#questionCustomAnswer:not(:disabled)")?.focus();
}

export function submitCustomQuestionAnswer(ctx: QuestionPanelContext): void {
  const input = ctx.root().querySelector<HTMLInputElement>("#questionCustomAnswer");
  const answer = input?.value.trim() ?? "";
  if (!answer) {
    expandCustomQuestionAnswer(ctx);
    ctx.setNotice("Type an answer before submitting, or choose Cancel.");
    return;
  }
  ctx.answer({ answer, selectedIndex: null, wasCustom: true });
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
  const customInput = root.querySelector<HTMLInputElement>("#questionCustomAnswer:not(:disabled)");
  if (customInput) {
    customInput.focus();
    return;
  }
  root.querySelector<HTMLElement>(".question-card.pending")?.focus();
}

export function handleQuestionPanelKeydown(ctx: QuestionPanelContext, event: KeyboardEvent): void {
  const question = ctx.pendingQuestion();
  if (!question) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (canAnswerPendingQuestion(ctx)) ctx.answer({ cancelled: true, selectedIndex: null, wasCustom: false });
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  if (active?.id === "questionCustomAnswer") return;
  const buttons = Array.from(ctx.root().querySelectorAll<HTMLButtonElement>("[data-question-option-index]:not(:disabled)"));
  if (buttons.length === 0) return;
  const focusedIndex = buttons.findIndex((button) => button === active);
  const recommendedIndex = recommendedQuestionOptionIndex(question);
  const currentIndex = focusedIndex >= 0 ? focusedIndex : recommendedIndex >= 0 ? buttons.findIndex((button) => Number(button.dataset.questionOptionIndex ?? "-1") === recommendedIndex) : 0;
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const focusButton = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    event.preventDefault();
    focusButton(focusedIndex >= 0 ? safeCurrentIndex + 1 : safeCurrentIndex);
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    event.preventDefault();
    focusButton(focusedIndex >= 0 ? safeCurrentIndex - 1 : safeCurrentIndex);
  } else if (event.key === "Home") {
    event.preventDefault();
    buttons[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    buttons[buttons.length - 1]?.focus();
  } else if (event.key === "Enter" || event.key === " ") {
    const button = buttons[safeCurrentIndex];
    const index = Number(button?.dataset.questionOptionIndex ?? "-1");
    const option = question.options[index];
    if (option && canAnswerPendingQuestion(ctx)) {
      event.preventDefault();
      ctx.answer({ answer: option.label, selectedIndex: index, wasCustom: false });
    }
  } else if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    const option = question.options[index];
    if (option && canAnswerPendingQuestion(ctx)) {
      event.preventDefault();
      ctx.answer({ answer: option.label, selectedIndex: index, wasCustom: false });
    }
  } else if (event.key.toLowerCase() === "c" && question.allowCustomAnswer && !ctx.isSubmitting()) {
    const customInput = ctx.root().querySelector<HTMLInputElement>("#questionCustomAnswer:not(:disabled)");
    if (customInput) {
      event.preventDefault();
      expandCustomQuestionAnswer(ctx);
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
  card.querySelector<HTMLButtonElement>("#questionCustomToggle")?.addEventListener("click", () => { if (!ctx.isSubmitting()) expandCustomQuestionAnswer(ctx); });
  card.querySelector<HTMLButtonElement>("#questionCustomSubmit")?.addEventListener("click", () => { if (canAnswerPendingQuestion(ctx)) submitCustomQuestionAnswer(ctx); });
  card.querySelector<HTMLInputElement>("#questionCustomAnswer")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && canAnswerPendingQuestion(ctx)) {
      event.preventDefault();
      submitCustomQuestionAnswer(ctx);
    }
  });
  card.querySelector<HTMLButtonElement>("#questionCancel")?.addEventListener("click", () => { if (canAnswerPendingQuestion(ctx)) ctx.answer({ cancelled: true, selectedIndex: null, wasCustom: false }); });
}

export function renderQuestionPanel(question: PendingQuestion | null, isController: boolean, isConnected: boolean, isSubmitting = false): string {
  if (!question) return "";
  const disabled = !isController || !isConnected || isSubmitting;
  const viewerCopy = isSubmitting
    ? `<p class="question-viewer-copy">Submitting answer…</p>`
    : !isController
      ? `<p class="question-viewer-copy">Take control to answer this question. Keyboard answer shortcuts are disabled in viewer mode.</p>`
      : !isConnected
        ? `<p class="question-viewer-copy">Reconnect before answering. Keyboard answer shortcuts are disabled while disconnected.</p>`
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
        ${question.allowCustomAnswer ? `<div class="question-custom ${question.options.length ? "is-collapsed" : "is-expanded"}">
          <button id="questionCustomToggle" class="question-custom-toggle" type="button" ${disabled ? "disabled" : ""}><kbd>C</kbd> Custom answer…</button>
          <label class="question-custom-field"><span><kbd>C</kbd> Custom</span><input id="questionCustomAnswer" type="text" ${disabled ? "disabled" : ""} placeholder="Type a custom answer…" /></label>
          <button id="questionCustomSubmit" type="button" ${disabled ? "disabled" : ""}>Answer <kbd>Enter</kbd></button>
        </div>` : ""}
        <div class="question-actions">
          ${viewerCopy}
          <span class="question-key-hint"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>1-9</kbd> answer · <kbd>C</kbd> custom · <kbd>Esc</kbd> cancel</span>
          <span class="question-touch-hint">Tap an option or type a custom answer.</span>
          <button id="questionCancel" type="button" aria-keyshortcuts="Escape" ${disabled ? "disabled" : ""}>Cancel question</button>
        </div>
      </section>`;
}
