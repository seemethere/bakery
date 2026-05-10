import { describe, expect, test } from "bun:test";
import { handleComposerImageFiles, removePromptImage, type ComposerImageControllerContext } from "./composer-images-controller";
import type { PromptImage } from "./prompt-images";

function context(overrides: Partial<ComposerImageControllerContext> = {}) {
  let images: PromptImage[] = overrides.promptImages?.() ?? [];
  let notice = "";
  let renderCount = 0;
  let promptDraft = "";
  const ctx: ComposerImageControllerContext = {
    promptImages: () => images,
    setPromptImages: (next) => { images = next; },
    selectedSessionId: () => null,
    promptInput: () => null,
    promptDraft: () => promptDraft,
    setPromptDraft: (draft) => { promptDraft = draft; },
    createImageId: () => "image-id",
    api: async () => ({}),
    setNotice: (next) => { notice = next; },
    render: () => { renderCount += 1; },
    updatePromptDraft: () => {},
    schedulePromptDraftSave: () => {},
    ...overrides,
  };
  return {
    ctx,
    get images() { return images; },
    get notice() { return notice; },
    get renderCount() { return renderCount; },
  };
}

describe("composer image controller", () => {
  test("surfaces an empty browser file selection", async () => {
    const state = context();

    await handleComposerImageFiles(state.ctx, []);

    expect(state.notice).toBe("No files were provided by the browser. Try the paperclip file picker or paste the image.");
    expect(state.renderCount).toBe(2);
  });

  test("removes prompt images through the shared context", () => {
    const state = context({
      promptImages: () => [
        { id: "keep", name: "keep.png", mimeType: "image/png", dataUrl: "data:image/png;base64,keep", size: 1 },
        { id: "remove", name: "remove.png", mimeType: "image/png", dataUrl: "data:image/png;base64,remove", size: 1 },
      ],
    });

    removePromptImage(state.ctx, "remove");

    expect(state.images.map((image) => image.id)).toEqual(["keep"]);
    expect(state.renderCount).toBe(1);
  });
});
