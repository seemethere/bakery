import { beforeAll, describe, expect, test } from "bun:test";
import { PLAN_ACTIONS_MARKER } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "./transcript";

let UiActionController: typeof import("./ui-action-controller").UiActionController;
let PLAN_UI_ACTION_CONTRIBUTION: typeof import("./transcript").PLAN_UI_ACTION_CONTRIBUTION;

beforeAll(async () => {
  Object.defineProperty(globalThis, "HTMLElement", {
    value: class HTMLElement {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "customElements", {
    value: { define: () => undefined },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { location: { href: "http://127.0.0.1:5173/" } },
    configurable: true,
  });
  ({ UiActionController } = await import("./ui-action-controller"));
  ({ PLAN_UI_ACTION_CONTRIBUTION } = await import("./transcript"));
});

function planItem(id: string): TranscriptItem {
  return {
    id,
    kind: "assistant",
    title: "Pi",
    body: `## Plan summary\n\nDo the thing.\n\n${PLAN_ACTIONS_MARKER}`,
    status: "done",
  };
}

function createController(items: TranscriptItem[]) {
  const dirty = new Set<string>();
  const sentDrafts: string[] = [];
  let renderCount = 0;
  const controller = new UiActionController({
    transcript: () => items,
    status: () => "idle",
    socket: () => null,
    setPromptDraft: (value) => sentDrafts.push(value),
    clearPromptImages: () => undefined,
    updateRunningQueue: () => undefined,
    savePromptDraft: () => undefined,
    closeAutocompletes: () => undefined,
    focusPromptOnNextReadyRender: () => undefined,
    setNotice: () => undefined,
    markTranscriptDirty: (transcriptId) => dirty.add(transcriptId),
    render: () => { renderCount += 1; },
  });
  return { controller, dirty, sentDrafts, renderCount: () => renderCount };
}

describe("UiActionController plan outcomes", () => {
  test("accept marks a plan accepted once and preserves the prompt while disconnected", () => {
    const item = planItem("plan-1");
    const { controller, dirty, sentDrafts } = createController([item]);

    controller.handle(PLAN_UI_ACTION_CONTRIBUTION.id, "accept", item.id);
    controller.handle(PLAN_UI_ACTION_CONTRIBUTION.id, "accept", item.id);

    expect(controller.outcomeFor(item.id)).toBe("accepted");
    expect(sentDrafts).toEqual(["Proceed with the recommended plan."]);
    expect(dirty.has(item.id)).toBe(true);
  });

  test("reject marks a plan rejected without submitting text", () => {
    const item = planItem("plan-2");
    const { controller, sentDrafts, renderCount } = createController([item]);

    controller.handle(PLAN_UI_ACTION_CONTRIBUTION.id, "reject", item.id);

    expect(controller.outcomeFor(item.id)).toBe("rejected");
    expect(sentDrafts).toEqual([]);
    expect(renderCount()).toBe(1);
  });

  test("normal chat marks only the latest pending plan as discussing", () => {
    const first = planItem("plan-older");
    const latest = planItem("plan-latest");
    const { controller, dirty } = createController([first, latest]);

    expect(controller.markLatestPendingDiscussing()).toBe(latest.id);

    expect(controller.outcomeFor(first.id)).toBeUndefined();
    expect(controller.outcomeFor(latest.id)).toBe("discussing");
    expect(dirty.has(latest.id)).toBe(true);
  });
});
