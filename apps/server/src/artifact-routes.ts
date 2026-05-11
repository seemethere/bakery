import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  artifactRawQuerySchema,
  artifactUploadRequestSchema,
  fileRawQuerySchema,
} from "@pi-web-agent/protocol";
import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./metadata-store.js";
import { assertAllowedSessionWorkspace, type WorkspacePermissionScope } from "./workspaces.js";

const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

const imageExtensionsByMime = new Map(Array.from(imageMimeTypes, ([extension, mime]) => [mime, extension === ".jpg" ? ".jpeg" : extension]));
const promptAttachmentMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type ArtifactRouteDeps = {
  artifactDir: string;
  authToken?: string | undefined;
  store: MetadataStore;
  getWorkspacePermissionScope(): WorkspacePermissionScope;
};

function artifactIdFor(sessionId: string, path: string): string {
  return createHash("sha256").update(sessionId).update("\0").update(path).digest("hex").slice(0, 32);
}

function artifactFilePath(artifactDir: string, sessionId: string, artifactId: string, mimeType: string): string | null {
  const extension = imageExtensionsByMime.get(mimeType);
  if (!extension || !/^[a-f0-9]{32}$/.test(artifactId)) return null;
  return join(artifactDir, sessionId, `${artifactId}${extension}`);
}

function safeAttachmentName(name: string, fallback: string): string {
  const cleaned = name.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function artifactUrl(origin: string, sessionId: string, originalPath: string, token?: string): string {
  const url = new URL(`/api/sessions/${sessionId}/artifacts/raw`, origin);
  url.searchParams.set("path", originalPath);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

async function resolveSessionFile(cwd: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0")) throw new Error("invalid path");
  const cwdReal = await realpath(cwd);
  const candidate = await realpath(resolve(cwdReal, relativePath));
  const rel = relative(cwdReal, candidate);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || resolve(rel) === rel) throw new Error("path is outside session workspace");
  return candidate;
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void {
  const { artifactDir, authToken, store } = deps;

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files/raw", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = fileRawQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const mime = imageMimeTypes.get(extensionOf(parsed.data.path));
    if (!mime) return reply.code(415).send({ error: "only image previews are supported" });
    if (session.cwd === null) return reply.code(404).send({ error: "session has no workspace" });
    try {
      await assertAllowedSessionWorkspace(session, deps.getWorkspacePermissionScope());
      const file = await resolveSessionFile(session.cwd, parsed.data.path);
      const info = await stat(file);
      if (!info.isFile()) return reply.code(404).send({ error: "file not found" });
      if (info.size > 20 * 1024 * 1024) return reply.code(413).send({ error: "file too large to preview" });
      reply.header("Cache-Control", "private, max-age=30");
      return reply.type(mime).send(await readFile(file));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/sessions/:id/artifacts", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = artifactUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const pathMime = imageMimeTypes.get(extensionOf(parsed.data.path));
    if (!pathMime || pathMime !== parsed.data.mimeType) return reply.code(415).send({ error: "artifact path extension must match a supported image MIME type" });
    const data = Buffer.from(parsed.data.data.replace(/\s/g, ""), "base64");
    if (data.length === 0) return reply.code(400).send({ error: "artifact data is empty" });
    if (data.length > 20 * 1024 * 1024) return reply.code(413).send({ error: "artifact too large" });
    const artifactId = artifactIdFor(session.id, parsed.data.path);
    const file = artifactFilePath(artifactDir, session.id, artifactId, parsed.data.mimeType);
    if (!file) return reply.code(415).send({ error: "only image artifacts are supported" });
    await mkdir(join(artifactDir, session.id), { recursive: true });
    await writeFile(file, data, { mode: 0o600 });
    return reply.code(201).send({
      artifactId,
      path: parsed.data.path,
      mimeType: parsed.data.mimeType,
      size: data.length,
      url: artifactUrl(`${request.protocol}://${request.headers.host ?? "localhost"}`, session.id, parsed.data.path, authToken),
    });
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/attachments", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    if (!request.isMultipart()) return reply.code(415).send({ error: "multipart/form-data required" });
    const attachments = [];
    const parts = request.files({ limits: { fileSize: 20 * 1024 * 1024, files: 8 } });
    for await (const part of parts) {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      if (data.length === 0) continue;
      if (data.length > 20 * 1024 * 1024) return reply.code(413).send({ error: `${part.filename} is too large` });
      const providedMime = part.mimetype || "application/octet-stream";
      const extensionMime = imageMimeTypes.get(extensionOf(part.filename));
      const mimeType = imageExtensionsByMime.has(providedMime) ? providedMime : extensionMime;
      if (!mimeType || !promptAttachmentMimeTypes.has(mimeType)) return reply.code(415).send({ error: `unsupported attachment type: ${providedMime || part.filename}` });
      const extension = imageExtensionsByMime.get(mimeType)!;
      const originalName = safeAttachmentName(part.filename || `attachment${extension}`, `attachment${extension}`);
      const baseName = /\.[a-z0-9]+$/i.test(originalName) ? originalName.replace(/\.[a-z0-9]+$/i, "") : originalName;
      const createdAt = new Date().toISOString();
      const path = `.bakery/attachments/${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${baseName}${extension}`;
      const artifactId = artifactIdFor(session.id, path);
      const file = artifactFilePath(artifactDir, session.id, artifactId, mimeType);
      if (!file) return reply.code(415).send({ error: "only image attachments are supported" });
      await mkdir(join(artifactDir, session.id), { recursive: true });
      await writeFile(file, data, { mode: 0o600 });
      attachments.push({
        id: artifactId,
        path,
        name: originalName,
        mimeType,
        size: data.length,
        kind: "image" as const,
        url: artifactUrl(`${request.protocol}://${request.headers.host ?? "localhost"}`, session.id, path, authToken),
        createdAt,
      });
    }
    if (attachments.length === 0) return reply.code(400).send({ error: "no attachment files uploaded" });
    return reply.code(201).send({ attachments });
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/artifacts/raw", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = artifactRawQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const mime = imageMimeTypes.get(extensionOf(parsed.data.path));
    if (!mime) return reply.code(415).send({ error: "only image previews are supported" });
    const artifactId = artifactIdFor(session.id, parsed.data.path);
    const file = artifactFilePath(artifactDir, session.id, artifactId, mime);
    if (!file) return reply.code(415).send({ error: "only image artifacts are supported" });
    try {
      const info = await stat(file);
      if (!info.isFile()) return reply.code(404).send({ error: "artifact not found" });
      if (info.size > 20 * 1024 * 1024) return reply.code(413).send({ error: "artifact too large to preview" });
      reply.header("Cache-Control", "private, max-age=300");
      return reply.type(mime).send(await readFile(file));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
