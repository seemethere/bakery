#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { artifactUploadResponseSchema } from "../packages/protocol/src/index.js";

const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

function usage(exitCode = 0): never {
  const text = `Upload an image artifact to a Bakery session.\n\nUsage:\n  bun scripts/upload-artifact.ts --session <id> [--api <url>] [--token <token>] [--path <remote-path>] <image-file>\n\nOptions:\n  --session <id>      Bakery session id. Defaults to PI_WEB_SESSION_ID.\n  --api <url>         Bakery API base URL. Defaults to PI_WEB_API_BASE or http://127.0.0.1:3141.\n  --token <token>     Auth token. Defaults to PI_WEB_AUTH_TOKEN.\n  --path <path>       Original remote path to associate with the artifact. Defaults to the image file path.\n  --help              Show this help.\n\nAfter upload, mention the same --path value in the transcript so Bakery can render the screenshot preview.\n`;
  (exitCode === 0 ? console.log : console.error)(text.trimEnd());
  process.exit(exitCode);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(1);
  args.splice(index, 2);
  return value;
}

function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage(0);

  const api = (takeOption(args, "--api") ?? process.env.PI_WEB_API_BASE ?? "http://127.0.0.1:3141").replace(/\/+$/, "");
  const token = takeOption(args, "--token") ?? process.env.PI_WEB_AUTH_TOKEN ?? "";
  const sessionId = takeOption(args, "--session") ?? process.env.PI_WEB_SESSION_ID;
  const remotePath = takeOption(args, "--path");
  const imageFile = args[0];
  if (!sessionId || !imageFile || args.length !== 1) usage(1);

  const filePath = resolve(imageFile);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (info.size > 20 * 1024 * 1024) throw new Error(`Image is too large to upload: ${info.size} bytes`);

  const mimeType = imageMimeTypes.get(extensionOf(filePath));
  if (!mimeType) throw new Error(`Unsupported image type for ${basename(filePath)}. Supported: png, jpg, jpeg, gif, webp, svg`);

  const path = remotePath ?? filePath;
  const data = Buffer.from(await readFile(filePath)).toString("base64");
  const response = await fetch(`${api}/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, mimeType, data }),
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  const parsed = artifactUploadResponseSchema.parse(await response.json());
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
