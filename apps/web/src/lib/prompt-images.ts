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

export function isSupportedImageFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  const files = Array.from(dataTransfer?.files ?? []).filter(isSupportedImageFile);
  if (files.length > 0) return files;

  return Array.from(dataTransfer?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedImageFile(file)));
}

export function imageMimeType(file: Pick<File, "type" | "name">): string {
  if (file.type === "image/jpg") return "image/jpeg";
  if (file.type.startsWith("image/")) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return file.type;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read image")));
    reader.readAsDataURL(file);
  });
}

export async function loadImageFile(file: File): Promise<PromptImage | string> {
  if (!isSupportedImageFile(file)) return `Unsupported image type: ${file.type || file.name}`;
  if (file.size > maxPromptImageBytes) return `${file.name} is larger than ${maxPromptImageBytes / 1024 / 1024}MB`;
  const mimeType = imageMimeType(file);
  const dataUrl = await readFileAsDataUrl(file);
  return {
    id: crypto.randomUUID(),
    name: file.name || "image",
    mimeType,
    dataUrl,
    size: file.size,
  };
}
