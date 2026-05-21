import { useState, useRef, useEffect } from "react";
import type { PendingQuestion, AnswerQuestionPayload, QuestionOption } from "@pi-web-agent/protocol";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function recommendedOptionIndex(question: PendingQuestion): number {
  if (typeof question.recommendedOptionIndex === "number" && question.recommendedOptionIndex >= 0 && question.recommendedOptionIndex < question.options.length) {
    return question.recommendedOptionIndex;
  }
  const rec = question.recommendation?.toLowerCase() ?? "";
  if (!rec) return -1;
  return question.options.findIndex((o) => o.label.toLowerCase() && rec.includes(o.label.toLowerCase()));
}

type Props = {
  question: PendingQuestion;
  canAnswer: boolean; // false when disconnected or viewer
  onAnswer: (payload: AnswerQuestionPayload) => void;
};

export function QuestionPanel({ question, canAnswer, onAnswer }: Props) {
  const [allOptionsOpen, setAllOptionsOpen] = useState(false);
  const [isMobileQuestionLayout, setIsMobileQuestionLayout] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const recIndex = recommendedOptionIndex(question);
  const inlineOptionLimit = 4;
  const hasOverflowOptions = isMobileQuestionLayout && question.options.length > inlineOptionLimit;
  const inlineOptions = hasOverflowOptions ? question.options.slice(0, 2) : question.options;

  // Auto-focus recommended option or first option on mount
  useEffect(() => {
    if (!canAnswer) return;
    if (question.options.length > 0) {
      const target = recIndex >= 0 ? recIndex : 0;
      panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-option-index]")[target]?.focus();
    }
  }, [question.id]); // only on new question

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileQuestionLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setAllOptionsOpen(false);
  }, [question.id, hasOverflowOptions]);

  function handleOptionClick(index: number) {
    const option = question.options[index];
    if (!option || !canAnswer) return;
    setAllOptionsOpen(false);
    onAnswer({ questionId: question.id, answer: option.label, selectedIndex: index, wasCustom: false });
  }

  function renderOption(option: QuestionOption, index: number, context: "inline" | "overlay" = "inline") {
    const isRec = index === recIndex;
    return (
      <button
        key={index}
        data-option-index={context === "inline" ? index : undefined}
        data-question-option-index={context === "inline" ? index : undefined}
        data-question-overlay-option-index={context === "overlay" ? index : undefined}
        type="button"
        disabled={!canAnswer}
        onClick={() => handleOptionClick(index)}
        className={cn(
          "group w-full text-left rounded-lg px-3 py-2 text-sm border transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-primary",
          isRec
            ? "recommended-option border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/15"
            : "border-border/40 bg-card/50 hover:bg-sidebar-accent",
          !canAnswer && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn(
            "option-shortcut shrink-0 w-5 h-5 rounded text-[10px] font-mono font-bold hidden sm:flex items-center justify-center border",
            isRec ? "border-yellow-500/50 text-yellow-400" : "border-border/50 text-muted-foreground",
          )}>
            {index + 1}
          </span>
          <span className="flex-1 font-medium">{option.label}</span>
          {isRec && <span className="text-[10px] text-yellow-400/70 font-medium">Recommended</span>}
        </span>
        {option.description && (
          <p className="mt-0.5 ml-7 text-xs text-muted-foreground">{option.description}</p>
        )}
      </button>
    );
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!canAnswer || allOptionsOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onAnswer({ questionId: question.id, cancelled: true, selectedIndex: null, wasCustom: false });
      return;
    }
    // Number shortcuts 1-9
    if (/^[1-9]$/.test(e.key)) {
      const index = Number(e.key) - 1;
      const option = question.options[index];
      if (option) { e.preventDefault(); handleOptionClick(index); }
      return;
    }
  }

  return (
    <section
      ref={panelRef}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      className="question-card pending relative z-[2] overflow-x-hidden rounded-xl border border-yellow-500/30 bg-yellow-500/5 shadow-xl focus:outline-none"
      aria-label="Answer needed"
    >
      {/* Header */}
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-1">
        <span className="text-xs font-semibold text-yellow-400/90 uppercase tracking-wide">Answer needed</span>
        {question.title && (
          <span className="text-xs text-muted-foreground truncate">{question.title}</span>
        )}
      </div>

      {/* Question text */}
      <p className="px-4 py-1 text-sm text-foreground leading-snug">{question.question}</p>

      {/* Recommendation (free-text, no matching option) */}
      {question.recommendation && recIndex < 0 && (
        <p className="px-4 pb-1 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/70">Recommended:</span> {question.recommendation}
        </p>
      )}

      {/* Options */}
      {question.options.length > 0 && (
        <div className="question-options px-3 pb-2 flex flex-col gap-1" role="listbox" aria-label="Answer options">
          {inlineOptions.map((option, index) => renderOption(option, index))}
          {hasOverflowOptions && (
            <button
              type="button"
              className="question-show-all-options rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-yellow-500/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-primary"
              onClick={() => setAllOptionsOpen(true)}
              disabled={!canAnswer}
            >
              Show all {question.options.length} options
              <span className="ml-2 text-xs font-normal text-muted-foreground">Opens a larger chooser</span>
            </button>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border/20 bg-muted/10">
        {!canAnswer ? (
          <p className="text-xs text-yellow-500/70">Reconnect to answer this question.</p>
        ) : (
          <>
            <span className="question-key-hint text-[10px] text-muted-foreground/50 hidden sm:block">
              <kbd className="px-1 py-0.5 rounded bg-muted border border-border/40">1-9</kbd> answer &nbsp;
              <kbd className="px-1 py-0.5 rounded bg-muted border border-border/40">Esc</kbd> cancel; reply normally in the composer
            </span>
            <span className="question-touch-hint text-[10px] text-muted-foreground/50 sm:hidden">Reply below or tap an option.</span>
          </>
        )}
        <button
          type="button"
          disabled={!canAnswer}
          onClick={() => onAnswer({ questionId: question.id, cancelled: true, selectedIndex: null, wasCustom: false })}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          Cancel question
        </button>
      </div>

      <Dialog open={allOptionsOpen} onOpenChange={setAllOptionsOpen}>
        <DialogContent className="question-options-dialog grid max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton>
          <DialogHeader className="border-b border-border/60 px-4 py-3">
            <DialogTitle>{question.title || "Choose an answer"}</DialogTitle>
            <DialogDescription className="text-sm leading-5">{question.question}</DialogDescription>
          </DialogHeader>
          <div className="question-options-dialog-list flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-3 py-3" role="listbox" aria-label="All answer options">
            {question.options.map((option, index) => renderOption(option, index, "overlay"))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
