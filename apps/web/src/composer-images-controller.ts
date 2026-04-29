import { artifactPathForFile, imageMimeType, isSupportedImageFile, maxArtifactImageBytes, maxPromptImageBytes, maxPromptImages, readFileAsBase64, readFileAsDataUrl, supportedPromptImageTypes, type PromptImage } from "./prompt-images";

export type ComposerImageControllerContext = {
  promptImages: () => PromptImage[];
  setPromptImages: (images: PromptImage[]) => void;
  selectedSessionId: () => string | null | undefined;
  promptInput: () => HTMLTextAreaElement | null;
  promptDraft: () => string;
  setPromptDraft: (draft: string) => void;
  createImageId: () => string;
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  setNotice: (notice: string) => void;
  render: () => void;
  updatePromptDraft: (input: HTMLTextAreaElement) => void;
  schedulePromptDraftSave: () => void;
};

export type AddPromptImageOptions = { render?: boolean; quiet?: boolean };

function fileDescription(file: File): string {
  return `${file.name || "unnamed"}${file.type ? ` (${file.type})` : ""}`;
}

export async function handleComposerImageFiles(ctx: ComposerImageControllerContext, files: FileList | File[]): Promise<void> {
  const stableFiles = Array.from(files);
  ctx.setNotice(`Processing ${stableFiles.length} selected file${stableFiles.length === 1 ? "" : "s"}…`);
  ctx.render();
  if (stableFiles.length === 0) {
    ctx.setNotice("No files were provided by the browser. Try the paperclip file picker or paste the image.");
    ctx.render();
    return;
  }
  try {
    const attachedCount = await addPromptImageFiles(ctx, stableFiles, { quiet: true });
    if (attachedCount === 0) {
      ctx.setNotice(`No supported image files found. Supported: PNG, JPEG, GIF, WebP. Saw: ${stableFiles.map(fileDescription).join(", ")}`);
      ctx.render();
      return;
    }
    if (!ctx.selectedSessionId()) {
      ctx.setNotice("Image attached to the prompt. Open a session to upload a transcript preview artifact.");
      ctx.render();
      return;
    }
    try {
      await uploadImageArtifacts(ctx, stableFiles);
    } catch (error) {
      ctx.setNotice(`Attached image to prompt, but transcript preview upload failed: ${error instanceof Error ? error.message : String(error)}`);
      ctx.render();
    }
  } catch (error) {
    ctx.setNotice(`Could not attach image: ${error instanceof Error ? error.message : String(error)}`);
    ctx.render();
  }
}

export async function uploadImageArtifacts(ctx: ComposerImageControllerContext, files: FileList | File[]): Promise<void> {
  const selectedSessionId = ctx.selectedSessionId();
  if (!selectedSessionId) {
    ctx.setNotice("Open a session before uploading transcript artifacts.");
    ctx.render();
    return;
  }
  const incoming = Array.from(files).filter((file) => isSupportedImageFile(file));
  if (incoming.length === 0) return;
  const input = ctx.promptInput();
  const uploadedPaths: string[] = [];
  for (const file of incoming) {
    const mimeType = imageMimeType(file);
    if (!supportedPromptImageTypes.has(mimeType)) {
      ctx.setNotice(`Unsupported image type: ${file.type || file.name}`);
      continue;
    }
    if (file.size > maxArtifactImageBytes) {
      ctx.setNotice(`${file.name} is larger than 20 MB.`);
      continue;
    }
    const path = artifactPathForFile(file);
    const data = await readFileAsBase64(file);
    await ctx.api(`/api/sessions/${selectedSessionId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ path, mimeType, data }),
    });
    uploadedPaths.push(path);
  }
  if (uploadedPaths.length > 0) {
    const insertion = uploadedPaths.map((path) => `Screenshot artifact: ${path}`).join("\n");
    if (input) {
      const prefix = input.value.trimEnd();
      input.value = `${prefix}${prefix ? "\n" : ""}${insertion}`;
      ctx.updatePromptDraft(input);
    } else {
      const promptDraft = ctx.promptDraft();
      ctx.setPromptDraft(`${promptDraft.trimEnd()}${promptDraft.trim() ? "\n" : ""}${insertion}`);
      ctx.schedulePromptDraftSave();
    }
    ctx.setNotice("");
  }
  ctx.render();
}

export async function addPromptImageFiles(ctx: ComposerImageControllerContext, files: FileList | File[], options: AddPromptImageOptions = {}): Promise<number> {
  const incoming = Array.from(files).filter((file) => isSupportedImageFile(file));
  if (incoming.length === 0) return 0;
  const currentImages = ctx.promptImages();
  const added: PromptImage[] = [];
  for (const file of incoming) {
    if (currentImages.length + added.length >= maxPromptImages) {
      ctx.setNotice(`Only ${maxPromptImages} images can be attached to one prompt.`);
      break;
    }
    const mimeType = imageMimeType(file);
    if (!supportedPromptImageTypes.has(mimeType)) {
      ctx.setNotice(`Unsupported image type: ${file.type || file.name}`);
      continue;
    }
    if (file.size > maxPromptImageBytes) {
      ctx.setNotice(`${file.name} is larger than 8 MB.`);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    added.push({ id: ctx.createImageId(), name: file.name || "pasted-image", mimeType, dataUrl, size: file.size });
  }
  if (added.length > 0) {
    ctx.setPromptImages([...currentImages, ...added]);
    if (!options.quiet) ctx.setNotice("Image attachments are ready for this prompt only and are not preserved across page refreshes.");
  }
  if (options.render !== false) ctx.render();
  return added.length;
}

export function removePromptImage(ctx: Pick<ComposerImageControllerContext, "promptImages" | "setPromptImages" | "render">, id: string): void {
  ctx.setPromptImages(ctx.promptImages().filter((image) => image.id !== id));
  ctx.render();
}
