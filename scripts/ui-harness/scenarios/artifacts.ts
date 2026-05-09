import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { apiBase, artifactDir, root, webBase } from "../config";
import { spawn } from "node:child_process";
import {
  assertComposerMode,
  collectMetrics,
  delay,
  prepareSession,
  selectedSessionId,
  sendPromptAndWaitIdle,
  timed,
  waitForAgentIdle,
  waitForAgentRunning,
  waitForPromptDisabled,
  waitForPromptEnabled,
  waitForSelectedSession,
} from "./helpers";

export const artifactScenarios = [
  "image-attachments",
  "image-paste-attachments",
  "image-artifact-drop-upload",
  "image-artifact-paths",
  "repeated-image-artifact-paths",
  "artifact-path-formats",
  "remote-image-artifact-paths",
  "remote-image-artifact-upload",
  "missing-remote-image-artifact",
] as const;

async function chooseImageWithPaperclip(page: Page, imagePath: string, options: { forceRenderWhileOpen?: boolean } = {}): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#prompt").focus();
  await page.locator("#attachImages").click();
  const fileChooser = await chooser;
  // Real native file pickers often stay open long enough for unrelated app renders
  // to happen. Force one here so the harness catches input replacement races.
  if (options.forceRenderWhileOpen) {
    await page.evaluate(() => (document.querySelector("pi-web-agent") as unknown as { render?: () => void } | null)?.render?.());
  }
  await page.waitForTimeout(250);
  await fileChooser.setFiles(imagePath);
}

async function pasteImage(page: Page, imageName = "pasted.png", target: "prompt" | "body" = "prompt"): Promise<void> {
  const locator = target === "prompt" ? page.locator("#prompt") : page.locator("body");
  await locator.evaluate(async (element, name) => {
    const response = await fetch("/bakery-logo-96.png");
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, imageName);
}

export async function runImageAttachments(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const imagePath = join(artifactDir, "fixture.png");
  await chooseImageWithPaperclip(page, imagePath, { forceRenderWhileOpen: true });
  await page.locator(".prompt-image img").waitFor({ timeout: 5_000 });
  await page.locator(".prompt-image button").click();
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });

  await chooseImageWithPaperclip(page, imagePath);
  await page.locator(".prompt-image", { hasText: "fixture.png" }).waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Please inspect this attached image and include an image preview in the reply.");
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  await page.locator(".message.assistant img").first().waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

export async function runImagePasteAttachments(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await pasteImage(page, "body-pasted.png", "body");
  await page.locator(".prompt-image", { hasText: "body-pasted.png" }).waitFor({ timeout: 5_000 });
  await page.locator(".prompt-image button").click();
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });

  await pasteImage(page, "pasted.png", "prompt");
  await page.locator(".prompt-image", { hasText: "pasted.png" }).waitFor({ timeout: 5_000 });
  await page.locator("#send").click();
  await waitForAgentRunning(page, 5_000);
  await waitForAgentIdle(page, 10_000);
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  const bodyText = await page.locator("body").textContent();
  if (bodyText?.includes("bad_message")) throw new Error("Image-only pasted prompt was rejected as bad_message");
  return { userImages: await page.locator(".message.user img").count(), ...(await collectMetrics(page)) };
}

export async function runImageArtifactDropUpload(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const imagePath = join(artifactDir, "fixture.png");
  await chooseImageWithPaperclip(page, imagePath);
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes(".bakery/artifacts/"), null, { timeout: 5_000 });
  const artifactPrompt = "Please echo this uploaded screenshot artifact path exactly: " + await page.locator("#prompt").inputValue();
  await sendPromptAndWaitIdle(page, artifactPrompt);
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 1 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/artifacts/raw"))) throw new Error(`Expected dropped artifact screenshots to use artifact raw endpoint, saw ${sources.join(", ")}`);
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), userImages: await page.locator(".message.user img").count(), sources, ...(await collectMetrics(page)) };
}

export async function runImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list a local image artifact path for screenshot path rendering validation.");
  const image = page.locator(".artifact-image img").first();
  await image.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".artifact-image img");
    return Boolean(img?.complete && img.naturalWidth > 0);
  });
  await page.locator(".artifact-image figcaption", { hasText: "screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  await image.click();
  await page.locator(".artifact-image.expanded img").waitFor({ timeout: 5_000 });
  await image.click();
  await page.waitForFunction(() => !document.querySelector(".artifact-image")?.classList.contains("expanded"));
  return collectMetrics(page);
}

export async function runRemoteImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list remote screenshot artifact paths for rendering validation.");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img, .markdown-body img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img, .markdown-body img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (sources.some((src) => src.startsWith("file://"))) throw new Error(`Expected remote screenshots to use safe raw-file URLs, saw ${sources.join(", ")}`);
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/files/raw"))) throw new Error(`Expected remote screenshots to use raw-file endpoint, saw ${sources.join(", ")}`);
  await page.locator(".artifact-image figcaption", { hasText: "/screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), renderedImages: sources.length, sources, ...(await collectMetrics(page)) };
}

export async function runRemoteImageArtifactUpload(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const remotePath = "/remote/agent/workspace/screenshots/uploaded.png";
  const uploadedFixturePath = join(artifactDir, "fixture.png");
  const upload = spawn("bun", ["scripts/upload-artifact.ts", "--api", apiBase, "--session", sessionId, "--path", remotePath, uploadedFixturePath], {
    cwd: root,
    env: { ...process.env, PI_WEB_AUTH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let uploadOutput = "";
  upload.stdout.on("data", (chunk) => { uploadOutput += String(chunk); });
  upload.stderr.on("data", (chunk) => { uploadOutput += String(chunk); });
  const uploadCode = await new Promise<number | null>((resolve) => upload.on("exit", resolve));
  if (uploadCode !== 0) throw new Error(`Remote artifact upload CLI failed with code ${uploadCode}: ${uploadOutput}`);
  await sendPromptAndWaitIdle(page, "Please list uploaded remote screenshot artifact paths for rendering validation.");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img, .markdown-body img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img, .markdown-body img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/artifacts/raw"))) throw new Error(`Expected uploaded remote screenshots to use artifact raw endpoint, saw ${sources.join(", ")}`);
  await page.locator(".artifact-image figcaption", { hasText: "uploaded.png" }).waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), renderedImages: sources.length, sources, ...(await collectMetrics(page)) };
}

export async function runMissingRemoteImageArtifact(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list uploaded remote screenshot artifact paths for rendering validation, but do not upload the file first.");
  await page.waitForFunction(() => (window.__piWebFailedImageCount ?? 0) > 0, null, { timeout: 5_000 });
  await page.waitForFunction(() => document.querySelectorAll(".artifact-image img, .markdown-body img").length === 0, null, { timeout: 5_000 });
  await page.waitForTimeout(500);
  const afterInitialFailure = await page.evaluate(() => window.__piWebFailedImageCount ?? 0);
  await page.locator(".message.assistant").first().click();
  await page.waitForTimeout(500);
  const afterRerender = await page.evaluate(() => window.__piWebFailedImageCount ?? 0);
  if (afterRerender > afterInitialFailure) throw new Error(`Expected failed image URLs to be suppressed after first error; saw ${afterRerender - afterInitialFailure} extra image failures`);
  return { failedImageCount: afterRerender, ...(await collectMetrics(page)) };
}

export async function runRepeatedImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const prompt = "Please list a local image artifact path for repeated screenshot path rendering validation.";
  await sendPromptAndWaitIdle(page, prompt);
  await page.locator(".artifact-image img").first().waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, prompt);
  await page.waitForFunction(() => document.querySelectorAll(".artifact-image img").length >= 2, null, { timeout: 5_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const captions = await page.locator(".artifact-image figcaption", { hasText: "screenshots/fixture.png" }).count();
  if (captions < 2) throw new Error(`Expected repeated artifact path to render at least twice, saw ${captions} captions`);
  return { artifactImages: await page.locator(".artifact-image img").count(), captions, ...(await collectMetrics(page)) };
}

export async function runArtifactPathFormats(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list inline fenced long artifact format variants for local screenshot rendering validation.");
  const expected = ["screenshots/inline.png", "screenshots/fenced.png", "test-results/ui-harness/sample-run/final.png"];
  await page.waitForFunction((expectedPaths) => {
    const captions = Array.from(document.querySelectorAll(".artifact-image figcaption"), (caption) => caption.textContent ?? "");
    return expectedPaths.every((path) => captions.includes(path));
  }, expected, { timeout: 5_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 3 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), expected, ...(await collectMetrics(page)) };
}


