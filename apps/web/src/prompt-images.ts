import { escapeHtml } from "./utils";

export type PromptImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

export const supportedPromptImageTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
export const maxPromptImages = 4;
export const maxPromptImageBytes = 8 * 1024 * 1024;
export const maxArtifactImageBytes = 20 * 1024 * 1024;

export function isSupportedImageFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
}

export function imageMimeType(file: Pick<File, "type" | "name">): string {
  if (file.type === "image/jpg") return "image/jpeg";
  if (file.type.startsWith("image/")) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return file.type;
}

export function artifactPathForFile(file: Pick<File, "name">, now = new Date()): string {
  const safeName = (file.name || "screenshot.png").replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "screenshot.png";
  return `.bakery/artifacts/${now.toISOString().replace(/[:.]/g, "-")}-${safeName}`;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read image")));
    reader.readAsDataURL(file);
  });
}

export async function readFileAsBase64(file: Blob): Promise<string> {
  return (await readFileAsDataUrl(file)).replace(/^data:[^,]+,/, "");
}

export function renderPromptImages(promptImages: readonly PromptImage[]): string {
  if (promptImages.length === 0) return "";
  return `
      <div class="prompt-images" aria-label="Attached prompt images">
        ${promptImages.map((image) => `
          <figure class="prompt-image">
            <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" />
            <figcaption title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</figcaption>
            <button type="button" data-remove-image-id="${escapeHtml(image.id)}" aria-label="Remove ${escapeHtml(image.name)}">×</button>
          </figure>`).join("")}
      </div>`;
}
