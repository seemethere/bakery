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

export const appConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  authRequired: z.boolean(),
  workspaceRoots: z.array(z.string()),
  toolPermissionPolicy: toolPermissionPolicySchema,
  modelPolicy: modelPolicySchema,
  resourcePolicy: resourcePolicySchema,
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

export const sessionSnapshotSchema = z.object({
  session: webSessionSchema,
  status: z.enum(["idle", "running", "aborting", "error"]),
  messages: z.array(z.unknown()),
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
  z.object({ type: z.literal("controller_update"), controller: z.unknown().optional() }),
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
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type HelloMessage = {
  type: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  serverVersion: string;
};
