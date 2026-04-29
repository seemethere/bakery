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

describe("question panel controller", () => {
  test("derives a recommended option from recommendation copy", () => {
    expect(recommendedQuestionOptionIndex(question)).toBe(0);
    expect(recommendedQuestionOptionIndex({ ...question, recommendedOptionIndex: 1 })).toBe(1);
  });

  test("renders disabled viewer state", () => {
    const html = renderQuestionPanel(question, false, true);

    expect(html).toContain("Take control to answer this question");
    expect(html).toContain("disabled");
    expect(html).toContain("Recommended");
    expect(html).toContain("Which path?");
  });
});
