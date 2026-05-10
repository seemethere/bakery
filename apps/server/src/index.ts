import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { addWorkspaceRequestSchema, cloneWorkspaceRequestSchema, createGithubRepositoryRequestSchema, type ModelInfo, updateAppSettingsRequestSchema } from "@pi-web-agent/protocol";
import { AuthStorage, getAgentDir, ModelRegistry } from "@mariozechner/pi-coding-agent";
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
import { isBrowserOriginAllowed } from "./security-origin.js";
import { createSessionHubRegistry } from "./session-hub.js";
import { registerSessionRoutes } from "./session-routes.js";
import { addExistingWorkspace, assertAllowedCwd, cloneWorkspace, createGithubRepositoryWorkspace, mergeWorkspaces, resolveWorkspaceRoots } from "./workspaces.js";

const config = loadConfig();
const configWorkspaceRoots = await resolveWorkspaceRoots(config.workspaceRoots);
const workspaceRoots = configWorkspaceRoots;
mkdirSync(config.sessionDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });
mkdirSync(config.worktreeDir, { recursive: true });
mkdirSync(config.previewRuntimeDir, { recursive: true });

const store = new MetadataStore(config.metadataDbPath);
const runner = config.fakeAgent ? new FakePiSessionRunner(config.modelPolicy) : new InProcessPiSessionRunner(config.modelPolicy);
const previewStacks = new PreviewStackManager({ config });
await loadConfiguredBakeryExtensions(config);
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
await app.register(websocket);
await app.register(multipart);

function isLocalhost(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/healthz") return;
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const originAllowed = isBrowserOriginAllowed({
    origin,
    requestHost: request.headers.host,
    authRequired: config.authRequired,
    allowedOrigins: config.allowedOrigins,
  });
  if (!originAllowed) return reply.code(403).send({ error: "browser origin is not allowed" });
  if (origin) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Max-Age", "600");
  }
  if (request.method === "OPTIONS") return reply.code(204).send();

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

function listVisibleWorkspaces() {
  return mergeWorkspaces(configWorkspaceRoots, store.listWorkspaces());
}

function toModelInfo(model: { id: string; provider: string; name?: string; reasoning?: boolean } | undefined): ModelInfo | null {
  if (!model) return null;
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    name: model.name ?? model.id,
    reasoning: model.reasoning,
  };
}

function configuredModelInfo(id: string): ModelInfo {
  const slash = id.indexOf("/");
  return {
    id,
    provider: slash >= 0 ? id.slice(0, slash) : "model",
    name: slash >= 0 ? id.slice(slash + 1) : id,
  };
}

async function listAvailableModels(): Promise<ModelInfo[]> {
  if (config.fakeAgent) {
    return [
      { id: "fake/fast", provider: "fake", name: "Fake Fast" },
      { id: "fake/slow", provider: "fake", name: "Fake Slow" },
    ].filter((model) => !config.modelPolicy.allowedModels || config.modelPolicy.allowedModels.includes(model.id));
  }
  const agentDir = getAgentDir();
  const registry = ModelRegistry.create(AuthStorage.create(join(agentDir, "auth.json")), join(agentDir, "models.json"));
  return registry
    .getAvailable()
    .map((model) => toModelInfo(model))
    .filter((model): model is ModelInfo => Boolean(model))
    .filter((model) => !config.modelPolicy.allowedModels || config.modelPolicy.allowedModels.includes(model.id));
}

async function assertAllowedWorkspaceBase(path: string): Promise<void> {
  await assertAllowedCwd(path, configWorkspaceRoots);
}


app.get("/api/workspaces", async () => listVisibleWorkspaces());

app.post("/api/workspaces", async (request, reply) => {
  const parsed = addWorkspaceRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const candidate = await addExistingWorkspace(parsed.data.path);
    await assertAllowedWorkspaceBase(candidate.path);
    const workspace = store.addWorkspace(candidate);
    return reply.code(201).send({ workspace, message: "Workspace added" });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspaces/clone", async (request, reply) => {
  const parsed = cloneWorkspaceRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const basePath = await addExistingWorkspace(parsed.data.basePath ?? configWorkspaceRoots[0] ?? process.cwd());
    await assertAllowedWorkspaceBase(basePath.path);
    const workspace = store.addWorkspace(await cloneWorkspace({
      url: parsed.data.url,
      basePath: basePath.path,
      ...(parsed.data.targetName ? { targetName: parsed.data.targetName } : {}),
    }));
    return reply.code(201).send({ workspace, message: "Repository cloned" });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspaces/github", async (request, reply) => {
  const parsed = createGithubRepositoryRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const basePath = await addExistingWorkspace(parsed.data.basePath ?? configWorkspaceRoots[0] ?? process.cwd());
    await assertAllowedWorkspaceBase(basePath.path);
    const githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const workspace = store.addWorkspace(await createGithubRepositoryWorkspace({
      name: parsed.data.name,
      basePath: basePath.path,
      ...(parsed.data.owner ? { owner: parsed.data.owner } : {}),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.private !== undefined ? { private: parsed.data.private } : {}),
      ...(githubToken ? { token: githubToken } : {}),
    }));
    return reply.code(201).send({ workspace, message: "GitHub repository created and cloned" });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/extensions", async () => ({
  webModules: getBakeryExtensionWebModules(),
  cards: getBakeryExtensionCardContributions(),
  issues: getBakeryExtensionRegistry().issues,
}));

app.get<{ Params: { extensionId: string; "*": string } }>("/api/extensions/:extensionId/web/*", async (request, reply) => {
  const extension = getBakeryExtensionRegistry().extensions.find((candidate) => candidate.id === request.params.extensionId);
  if (!extension?.rootDir) return reply.code(404).send({ error: "extension not found" });
  const relativePath = request.params["*"];
  const filePath = resolve(extension.rootDir, relativePath);
  const root = resolve(extension.rootDir);
  if (filePath !== root && !filePath.startsWith(`${root}/`)) return reply.code(403).send({ error: "invalid extension asset path" });
  if (!existsSync(filePath)) return reply.code(404).send({ error: "extension asset not found" });
  const contentType = extname(filePath) === ".js" ? "application/javascript; charset=utf-8" : extname(filePath) === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
  return reply.header("Content-Type", contentType).send(await readFile(filePath));
});

app.get("/api/models", async () => {
  const discoveredModels = await listAvailableModels();
  const configuredDefault = config.modelPolicy.defaultModel ? configuredModelInfo(config.modelPolicy.defaultModel) : null;
  const models = discoveredModels.length > 0
    ? discoveredModels
    : configuredDefault
      ? [configuredDefault]
      : [];
  const defaultModel = config.modelPolicy.defaultModel ?? models[0]?.id ?? null;
  return {
    defaultModel,
    models,
    thinking: {
      default: config.modelPolicy.defaultThinkingLevel,
      levels: config.modelPolicy.allowedThinkingLevels,
    },
  };
});

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
