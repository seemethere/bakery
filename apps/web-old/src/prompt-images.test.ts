import { describe, expect, test } from "bun:test";
import { artifactPathForFile, imageMimeType, isSupportedImageFile, renderPromptImages } from "./prompt-images";

function fileLike(name: string, type = ""): Pick<File, "name" | "type"> {
  return { name, type };
}

describe("prompt image helpers", () => {
  test("detects supported pasted and extension-only image files", () => {
    expect(isSupportedImageFile(fileLike("paste", "image/png"))).toBe(true);
    expect(isSupportedImageFile(fileLike("screen.JPG"))).toBe(true);
    expect(isSupportedImageFile(fileLike("notes.txt", "text/plain"))).toBe(false);
  });

  test("normalizes image mime types from browser type or filename", () => {
    expect(imageMimeType(fileLike("photo.jpg", "image/jpg"))).toBe("image/jpeg");
    expect(imageMimeType(fileLike("photo.jpeg"))).toBe("image/jpeg");
    expect(imageMimeType(fileLike("capture.webp"))).toBe("image/webp");
    expect(imageMimeType(fileLike("unknown.bin", "application/octet-stream"))).toBe("application/octet-stream");
  });

  test("creates stable sanitized artifact paths", () => {
    const path = artifactPathForFile(fileLike("Screenshot 1: alpha/beta.png"), new Date("2026-04-27T22:00:00.123Z"));
    expect(path).toBe(".bakery/artifacts/2026-04-27T22-00-00-123Z-Screenshot-1-alpha-beta.png");
  });

  test("escapes prompt image markup", () => {
    const html = renderPromptImages([{ id: 'id"1', name: '<shot>.png', mimeType: "image/png", dataUrl: 'data:image/png;base64,abc"', size: 3 }]);
    expect(html).toContain("prompt-images");
    expect(html).toContain("&lt;shot&gt;.png");
    expect(html).toContain("id&quot;1");
    expect(html).not.toContain('<shot>.png');
  });
});
