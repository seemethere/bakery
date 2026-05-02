import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { updateAppSettingsRequestSchema } from "@pi-web-agent/protocol";
import Fastify from "fastify";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { getBakeryExtensionCardContributions, getBakeryExtensionRegistry, getBakeryExtensionWebModules, loadConfiguredBakeryExtensions } from "./extensions.js";
import { loadConfig } from "./config.js";
import { FakePiSessionRunner } from "./fake-runner.js";
import { MetadataStore } from "./metadata-store.js";
import { registerMetadataRoutes } from "./metadata-routes.js";
import { InProcessPiSessionRunner } from "./pi-runner.js";
import { registerPreviewStackRoutes } from "./preview-stack-routes.js";
import { PreviewStackManager } from "./preview-stacks.js";
import { registerSearchRoutes } from "./search-routes.js";
import { createSessionHubRegistry } from "./session-hub.js";
import { registerSessionRoutes } from "./session-routes.js";
import { resolveWorkspaceRoots, toWorkspaces } from "./workspaces.js";

const config = loadConfig();
const workspaceRoots = await resolveWorkspaceRoots(config.workspaceRoots);
mkdirSync(config.sessionDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });
mkdirSync(config.worktreeDir, { recursive: true });
mkdirSync(config.previewRuntimeDir, { recursive: true });

const store = new MetadataStore(config.metadataDbPath);
const runner = config.fakeAgent ? new FakePiSessionRunner(config.modelPolicy) : new InProcessPiSessionRunner(config.modelPolicy);
const previewStacks = new PreviewStackManager({ config });
const extensionRegistry = await loadConfiguredBakeryExtensions(config);
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] });
await app.register(websocket);

function isLocalhost(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/healthz") return;

  if (config.authToken) {
    const header = request.headers.authorization;
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const queryToken = url.searchParams.get("token");
    if (header !== `Bearer ${config.authToken}` && queryToken !== config.authToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return;
  }

  if (!isLocalhost(request.ip)) {
    return reply.code(403).send({ error: "unauthenticated access is only allowed from localhost" });
  }
});

app.get("/healthz", async () => ({ ok: true, time: new Date().toISOString() }));

app.get("/api/config", async () => ({
  host: config.host,
  port: config.port,
  authRequired: config.authRequired,
  workspaceRoots,
  toolPermissionPolicy: config.toolPermissionPolicy,
  modelPolicy: config.modelPolicy,
  resourcePolicy: config.resourcePolicy,
  sessionLifecycle: config.sessionLifecycle,
  previewPublicBaseUrl: config.previewPublicBaseUrl ?? null,
}));

app.get("/api/workspaces", async () => toWorkspaces(workspaceRoots));

app.get("/api/extensions", async () => ({
  webModules: getBakeryExtensionWebModules(),
  cards: getBakeryExtensionCardContributions(),
  issues: getBakeryExtensionRegistry().issues,
}));

app.get<{ Params: { extensionId: string; "*": string } }>("/api/extensions/:extensionId/web/*", async (request, reply) => {
  const extension = extensionRegistry.extensions.find((candidate) => candidate.id === request.params.extensionId);
  if (!extension?.rootDir) return reply.code(404).send({ error: "extension not found" });
  const relativePath = request.params["*"];
  const filePath = resolve(extension.rootDir, relativePath);
  const root = resolve(extension.rootDir);
  if (filePath !== root && !filePath.startsWith(`${root}/`)) return reply.code(403).send({ error: "invalid extension asset path" });
  if (!existsSync(filePath)) return reply.code(404).send({ error: "extension asset not found" });
  const contentType = extname(filePath) === ".js" ? "application/javascript; charset=utf-8" : extname(filePath) === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
  return reply.header("Content-Type", contentType).send(await readFile(filePath));
});

app.get("/api/models", async () => ({
  defaultModel: config.modelPolicy.defaultModel ?? null,
  models: config.modelPolicy.allowedModels ?? [],
  thinking: {
    default: config.modelPolicy.defaultThinkingLevel,
    levels: config.modelPolicy.allowedThinkingLevels,
  },
}));

app.get("/api/settings", async () => store.getSettings());

app.patch("/api/settings", async (request, reply) => {
  const parsed = updateAppSettingsRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return store.updateSettings(parsed.data);
});

registerArtifactRoutes(app, { artifactDir: config.artifactDir, authToken: config.authToken, store });


const sessionHubRegistry = createSessionHubRegistry({ config, store, runner });

registerMetadataRoutes(app, {
  config,
  store,
  runner,
  getBroadcaster: sessionHubRegistry.getBroadcaster,
});
registerSearchRoutes(app, { store, runner });
registerPreviewStackRoutes(app, { store, previewStacks });
registerSessionRoutes(app, {
  config,
  workspaceRoots,
  store,
  runner,
  disposeHub: sessionHubRegistry.disposeHub,
});
sessionHubRegistry.registerRoutes(app);

const close = async () => {
  app.log.info("shutting down");
  await previewStacks.stopAll();
  await sessionHubRegistry.disposeAll();
  for (const session of store.listSessions()) await runner.disposeSession(session.id);
  store.close();
  await app.close();
};
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
