export type PromptImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

export const supportedPromptImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const maxPromptImages = 4;
export const maxPromptImageBytes = 8 * 1024 * 1024;
export const maxArtifactImageBytes = 20 * 1024 * 1024;

const imageExtensionsByMime = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpeg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

export function isSupportedImageFile(file: Pick<File, "type" | "name">): boolean {
  const mimeType = imageMimeType(file);
  return supportedPromptImageTypes.has(mimeType) || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
}

export type ImageDataTransferResult = {
  files: File[];
  imageLike: boolean;
};

function isImageLikeFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|svg)$/i.test(file.name);
}

export function imageDataTransferResult(dataTransfer: DataTransfer | null | undefined): ImageDataTransferResult {
  const transferFiles = Array.from(dataTransfer?.files ?? []);
  const supportedFiles = transferFiles.filter(isSupportedImageFile);
  if (supportedFiles.length > 0) return { files: supportedFiles, imageLike: true };

  const types = Array.from(dataTransfer?.types ?? []).map((type) => type.toLowerCase());
  const html = types.includes("text/html") ? (dataTransfer?.getData("text/html") ?? "") : "";
  const imageLikeFromTypes = types.some((type) => type === "files" || type.includes("image")) || /<img\b|data:image\//i.test(html);
  const imageLikeFromFiles = transferFiles.some(isImageLikeFile);
  const itemFiles: File[] = [];
  let imageLikeFromItems = false;
  for (const item of Array.from(dataTransfer?.items ?? [])) {
    if (item.kind !== "file") continue;
    if (item.type.startsWith("image/")) imageLikeFromItems = true;
    const file = item.getAsFile();
    if (!file) continue;
    if (isImageLikeFile(file)) imageLikeFromItems = true;
    if (isSupportedImageFile(file)) itemFiles.push(file);
  }

  return { files: itemFiles, imageLike: imageLikeFromTypes || imageLikeFromFiles || imageLikeFromItems || itemFiles.length > 0 };
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  return imageDataTransferResult(dataTransfer).files;
}

export function imageMimeType(file: Pick<File, "type" | "name">): string {
  if (file.type === "image/jpg") return "image/jpeg";
  if (supportedPromptImageTypes.has(file.type)) return file.type;
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

export async function readFileAsBase64(file: Blob): Promise<string> {
  return (await readFileAsDataUrl(file)).replace(/^data:[^,]+,/, "");
}

export function artifactPathForFile(file: Pick<File, "type" | "name">, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const mimeType = imageMimeType(file);
  const extension = imageExtensionsByMime.get(mimeType) ?? ".png";
  const rawName = file.name.trim() || `image${extension}`;
  const safeName = rawName.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `image${extension}`;
  const filename = /\.(?:png|jpe?g|gif|webp)$/i.test(safeName) ? safeName : `${safeName}${extension}`;
  return `.bakery/artifacts/${timestamp}-${filename}`;
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
