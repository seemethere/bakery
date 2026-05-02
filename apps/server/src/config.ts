import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AppConfig } from "@pi-web-agent/protocol";

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export type ServerConfig = AppConfig & {
  authToken?: string | undefined;
  metadataDbPath: string;
  sessionDir: string;
  artifactDir: string;
  worktreeDir: string;
  previewRuntimeDir: string;
  previewPublicBaseUrl?: string | undefined;
  fakeAgent: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const workspaceRoots = splitList(env.PI_WEB_WORKSPACE_ROOT).map(expandHome);
  if (workspaceRoots.length === 0) workspaceRoots.push(resolve(process.cwd()));

  const dataDir = expandHome(env.PI_WEB_DATA_DIR ?? "~/.pi-web-agent");
  const authToken = env.PI_WEB_AUTH_TOKEN?.trim() || undefined;

  return {
    host: env.PI_WEB_HOST ?? "127.0.0.1",
    port: Number(env.PI_WEB_PORT ?? "3141"),
    authRequired: Boolean(authToken),
    authToken,
    workspaceRoots,
    metadataDbPath: env.PI_WEB_METADATA_DB ?? resolve(dataDir, "metadata.sqlite"),
    sessionDir: env.PI_WEB_SESSION_DIR ? expandHome(env.PI_WEB_SESSION_DIR) : resolve(dataDir, "sessions"),
    artifactDir: env.PI_WEB_ARTIFACT_DIR ? expandHome(env.PI_WEB_ARTIFACT_DIR) : resolve(dataDir, "artifacts"),
    worktreeDir: env.PI_WEB_WORKTREE_DIR ? expandHome(env.PI_WEB_WORKTREE_DIR) : resolve(dataDir, "worktrees"),
    previewRuntimeDir: env.PI_WEB_PREVIEW_RUNTIME_DIR ? expandHome(env.PI_WEB_PREVIEW_RUNTIME_DIR) : resolve(dataDir, "preview-stacks"),
    previewPublicBaseUrl: env.PI_WEB_PREVIEW_PUBLIC_BASE_URL?.trim() || undefined,
    fakeAgent: env.PI_WEB_FAKE_AGENT === "true" || env.PI_WEB_FAKE_AGENT === "1",
    toolPermissionPolicy: {
      allowedModes: ["bypass", "confirm"],
      defaultMode: "bypass",
      confirmTools: [],
      denyTools: [],
    },
    modelPolicy: {
      ...(env.PI_WEB_DEFAULT_MODEL ? { defaultModel: env.PI_WEB_DEFAULT_MODEL } : {}),
      defaultThinkingLevel: env.PI_WEB_DEFAULT_THINKING ?? "medium",
      allowedThinkingLevels: splitList(env.PI_WEB_ALLOWED_THINKING).length
        ? splitList(env.PI_WEB_ALLOWED_THINKING)
        : ["off", "low", "medium", "high", "xhigh"],
      ...(splitList(env.PI_WEB_ALLOWED_MODELS).length ? { allowedModels: splitList(env.PI_WEB_ALLOWED_MODELS) } : {}),
    },
    resourcePolicy: {
      loadGlobalResources: env.PI_WEB_LOAD_GLOBAL_RESOURCES !== "false",
      loadProjectResources: env.PI_WEB_LOAD_PROJECT_RESOURCES !== "false",
      allowExtensions: env.PI_WEB_ALLOW_EXTENSIONS !== "false",
      allowSkills: env.PI_WEB_ALLOW_SKILLS !== "false",
      allowPromptTemplates: env.PI_WEB_ALLOW_PROMPT_TEMPLATES !== "false",
      allowContextFiles: env.PI_WEB_ALLOW_CONTEXT_FILES !== "false",
      additionalExtensionPaths: splitList(env.PI_WEB_EXTENSION_PATHS),
      additionalSkillPaths: splitList(env.PI_WEB_SKILL_PATHS),
    },
    sessionLifecycle: {
      disconnectedIdleTimeoutMs: Number(env.PI_WEB_DISCONNECTED_IDLE_TIMEOUT_MS ?? "900000"),
      disconnectedRunningPolicy: env.PI_WEB_DISCONNECTED_RUNNING_POLICY === "abort-after-timeout" ? "abort-after-timeout" : "let-finish",
    },
  };
}
