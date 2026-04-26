import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const toolPermissionModeSchema = z.enum(["bypass", "confirm", "deny"]);
export type ToolPermissionMode = z.infer<typeof toolPermissionModeSchema>;

export const toolPermissionPolicySchema = z.object({
  allowedModes: z.array(toolPermissionModeSchema),
  defaultMode: toolPermissionModeSchema,
  confirmTools: z.array(z.string()),
  denyTools: z.array(z.string()),
});
export type ToolPermissionPolicy = z.infer<typeof toolPermissionPolicySchema>;

export const modelPolicySchema = z.object({
  defaultModel: z.string().optional(),
  allowedModels: z.array(z.string()).optional(),
  defaultThinkingLevel: z.string(),
  allowedThinkingLevels: z.array(z.string()),
});
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

export const resourcePolicySchema = z.object({
  loadGlobalResources: z.boolean(),
  loadProjectResources: z.boolean(),
  allowExtensions: z.boolean(),
  allowSkills: z.boolean(),
  allowPromptTemplates: z.boolean(),
  allowContextFiles: z.boolean(),
  additionalExtensionPaths: z.array(z.string()).optional(),
  additionalSkillPaths: z.array(z.string()).optional(),
});
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;

export const sessionLifecycleConfigSchema = z.object({
  disconnectedIdleTimeoutMs: z.number().int().nonnegative(),
  disconnectedRunningPolicy: z.enum(["let-finish", "abort-after-timeout"]),
});
export type SessionLifecycleConfig = z.infer<typeof sessionLifecycleConfigSchema>;

export const appConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  authRequired: z.boolean(),
  workspaceRoots: z.array(z.string()),
  toolPermissionPolicy: toolPermissionPolicySchema,
  modelPolicy: modelPolicySchema,
  resourcePolicy: resourcePolicySchema,
  sessionLifecycle: sessionLifecycleConfigSchema,
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export const workspaceSchema = z.object({
  path: z.string(),
  label: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const webSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  piSessionFile: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
});
export type WebSession = z.infer<typeof webSessionSchema>;

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z.object({
  title: z.string().min(1).max(120).nullable().optional(),
  toolPermissionMode: toolPermissionModeSchema.optional(),
  uiStateJson: z.string().optional(),
});
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const fileMatchSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
});
export type FileMatch = z.infer<typeof fileMatchSchema>;

export const fileSearchQuerySchema = z.object({
  q: z.string().max(200).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type FileSearchQuery = z.infer<typeof fileSearchQuerySchema>;

export const fileSearchResponseSchema = z.object({
  query: z.string(),
  files: z.array(fileMatchSchema),
});
export type FileSearchResponse = z.infer<typeof fileSearchResponseSchema>;

export const fileCompleteQuerySchema = z.object({
  prefix: z.string().max(500).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type FileCompleteQuery = z.infer<typeof fileCompleteQuerySchema>;

export const fileCompleteResponseSchema = z.object({
  prefix: z.string(),
  files: z.array(fileMatchSchema),
});
export type FileCompleteResponse = z.infer<typeof fileCompleteResponseSchema>;

export const agentStatusSchema = z.enum(["idle", "running", "aborting", "error"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const controllerInfoSchema = z.object({
  clientId: z.string().nullable(),
  connectedClients: z.number().int().nonnegative(),
  currentClientId: z.string().optional(),
  isController: z.boolean().optional(),
});
export type ControllerInfo = z.infer<typeof controllerInfoSchema>;

export const modelInfoSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const sessionRuntimeSettingsSchema = z.object({
  model: modelInfoSchema.nullable(),
  availableModels: z.array(modelInfoSchema),
  thinkingLevel: z.string(),
  availableThinkingLevels: z.array(z.string()),
});
export type SessionRuntimeSettings = z.infer<typeof sessionRuntimeSettingsSchema>;

export const sessionSnapshotSchema = z.object({
  session: webSessionSchema,
  status: agentStatusSchema,
  messages: z.array(z.unknown()),
  controller: controllerInfoSchema.optional(),
  settings: sessionRuntimeSettingsSchema.optional(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const normalizedAgentEventSchema = z.object({
  type: z.string(),
  time: z.string(),
  data: z.unknown().optional(),
});
export type NormalizedAgentEvent = z.infer<typeof normalizedAgentEventSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_snapshot"), snapshot: sessionSnapshotSchema }),
  z.object({ type: z.literal("agent_event"), event: normalizedAgentEventSchema, raw: z.unknown().optional() }),
  z.object({ type: z.literal("controller_update"), controller: controllerInfoSchema }),
  z.object({ type: z.literal("settings_update"), settings: sessionRuntimeSettingsSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const serverEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.string(),
  payload: serverMessageSchema,
});
export type ServerEnvelope = z.infer<typeof serverEnvelopeSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello_ack"), protocolVersion: z.literal(PROTOCOL_VERSION), clientId: z.string().optional() }),
  z.object({ type: z.literal("prompt"), text: z.string().min(1), images: z.array(z.string()).optional() }),
  z.object({ type: z.literal("steer"), text: z.string().min(1) }),
  z.object({ type: z.literal("follow_up"), text: z.string().min(1) }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("take_control") }),
  z.object({ type: z.literal("set_model"), model: z.string().min(1) }),
  z.object({ type: z.literal("set_thinking"), level: z.string().min(1) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type HelloMessage = {
  type: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  serverVersion: string;
  clientId: string;
};
