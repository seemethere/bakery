import { useState, useRef, useEffect, useCallback } from "react";
import type { PendingQuestion, AnswerQuestionPayload } from "@pi-web-agent/protocol";
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
  const [customOpen, setCustomOpen] = useState(question.options.length === 0);
  const [customText, setCustomText] = useState("");
  const customInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const recIndex = recommendedOptionIndex(question);

  // Auto-focus recommended option or first option on mount
  useEffect(() => {
    if (!canAnswer) return;
    if (question.options.length > 0) {
      const target = recIndex >= 0 ? recIndex : 0;
      panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-option-index]")[target]?.focus();
    } else if (customOpen) {
      customInputRef.current?.focus();
    }
  }, [question.id]); // only on new question

  const submitCustom = useCallback(() => {
    const answer = customText.trim();
    if (!answer) { customInputRef.current?.focus(); return; }
    onAnswer({ questionId: question.id, answer, selectedIndex: null, wasCustom: true });
  }, [customText, question.id, onAnswer]);

  function handleOptionClick(index: number) {
    const option = question.options[index];
    if (!option || !canAnswer) return;
    onAnswer({ questionId: question.id, answer: option.label, selectedIndex: index, wasCustom: false });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!canAnswer) return;
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
    // C for custom
    if (e.key.toLowerCase() === "c" && question.allowCustomAnswer && document.activeElement?.id !== "questionCustomAnswer") {
      e.preventDefault();
      setCustomOpen(true);
      setTimeout(() => customInputRef.current?.focus(), 0);
      return;
    }
  }

  return (
    <section
      ref={panelRef}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      className="question-card relative z-[2] rounded-xl border border-yellow-500/30 bg-yellow-500/5 shadow-xl overflow-hidden focus:outline-none"
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
          {question.options.map((option, index) => {
            const isRec = index === recIndex;
            return (
              <button
                key={index}
                data-option-index={index}
                type="button"
                disabled={!canAnswer}
                onClick={() => handleOptionClick(index)}
                className={cn(
                  "group w-full text-left rounded-lg px-3 py-2 text-sm border transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-primary",
                  isRec
                    ? "border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/15"
                    : "border-border/40 bg-card/50 hover:bg-sidebar-accent",
                  !canAnswer && "opacity-50 cursor-not-allowed",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn(
                    "shrink-0 w-5 h-5 rounded text-[10px] font-mono font-bold flex items-center justify-center border",
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
          })}
        </div>
      )}

      {/* Custom answer */}
      {question.allowCustomAnswer && (
        <div className="px-3 pb-2">
          {!customOpen ? (
            <button
              type="button"
              disabled={!canAnswer}
              onClick={() => { setCustomOpen(true); setTimeout(() => customInputRef.current?.focus(), 0); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <kbd className="px-1 py-0.5 rounded bg-muted border border-border/50 text-[10px] mr-1">C</kbd>
              Custom answer…
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                ref={customInputRef}
                id="questionCustomAnswer"
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitCustom(); } }}
                disabled={!canAnswer}
                placeholder="Type a custom answer…"
                className="flex-1 min-w-0 text-sm bg-muted/30 border border-border/50 rounded-lg px-3 py-1.5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-sidebar-primary/50 disabled:opacity-50"
              />
              <button
                type="button"
                disabled={!canAnswer || !customText.trim()}
                onClick={submitCustom}
                className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-sidebar-primary/40 bg-sidebar-primary/15 text-foreground hover:bg-sidebar-primary/25 disabled:opacity-40 transition-colors"
              >
                Answer
              </button>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border/20 bg-muted/10">
        {!canAnswer ? (
          <p className="text-xs text-yellow-500/70">Reconnect to answer this question.</p>
        ) : (
          <span className="text-[10px] text-muted-foreground/50 hidden sm:block">
            <kbd className="px-1 py-0.5 rounded bg-muted border border-border/40">1-9</kbd> answer &nbsp;
            {question.allowCustomAnswer && <><kbd className="px-1 py-0.5 rounded bg-muted border border-border/40">C</kbd> custom &nbsp;</>}
            <kbd className="px-1 py-0.5 rounded bg-muted border border-border/40">Esc</kbd> cancel
          </span>
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
    </section>
  );
}
