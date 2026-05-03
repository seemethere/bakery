import { describe, expect, test } from "bun:test";
import type { PendingQuestion } from "@pi-web-agent/protocol";
import { recommendedQuestionOptionIndex, renderQuestionPanel } from "./question-panel-controller";

const question: PendingQuestion = {
  id: "q1",
  title: "Pick one",
  question: "Which path?",
  options: [
    { label: "Safe", description: "Smallest slice" },
    { label: "Fast", description: "More risk" },
  ],
  recommendation: "Safe is the better default.",
  allowCustomAnswer: true,
  createdAt: "2026-04-29T00:00:00.000Z",
};

describe("question card controller", () => {
  test("derives a recommended option from recommendation copy", () => {
    expect(recommendedQuestionOptionIndex(question)).toBe(0);
    expect(recommendedQuestionOptionIndex({ ...question, recommendedOptionIndex: 1 })).toBe(1);
  });

  test("renders disabled viewer state", () => {
    const html = renderQuestionPanel(question, false, true);

    expect(html).toContain("question-card pending");
    expect(html).toContain("Take control to answer this question");
    expect(html).toContain("disabled");
    expect(html).toContain("Recommended");
    expect(html).toContain("Which path?");
  });

  test("renders option shortcuts as secondary title metadata", () => {
    const html = renderQuestionPanel(question, true, true);

    expect(html).toContain('class="option-label"');
    expect(html).toContain('class="option-shortcut">1</kbd>');
    expect(html).toContain("<strong>Safe</strong><em>Recommended</em>");
  });

  test("uses the normal composer for freeform answers", () => {
    const html = renderQuestionPanel(question, true, true);

    expect(html).not.toContain("questionCustomToggle");
    expect(html).not.toContain("Custom answer");
    expect(html).toContain("Or reply normally in the composer.");
  });

  test("renders a disabled submitting state while an answer is in flight", () => {
    const html = renderQuestionPanel(question, true, true, true);

    expect(html).toContain("question-card pending is-submitting");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Submitting answer…");
    expect(html).toContain("disabled");
  });
});
