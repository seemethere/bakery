import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const PLAN_ACTIONS_MARKER = "Plan actions: Accept plan · Back to chat";
export const LEGACY_PLAN_ACTIONS_MARKER = "Plan actions: Accept plan · Give feedback · Cancel plan · Back to chat";

export const uiActionVariantSchema = z.enum(["primary", "secondary"]);
export type UiActionVariant = z.infer<typeof uiActionVariantSchema>;

export const uiActionPlacementSchema = z.enum(["composer_takeover"]);
export type UiActionPlacement = z.infer<typeof uiActionPlacementSchema>;

export const uiActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  variant: uiActionVariantSchema.optional(),
});
export type UiAction = z.infer<typeof uiActionSchema>;

export const uiActionContributionSchema = z.object({
  id: z.string().min(1),
  placement: uiActionPlacementSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  source: z.object({
    extensionId: z.string().min(1).optional(),
    commandName: z.string().min(1).optional(),
  }).optional(),
  actions: z.array(uiActionSchema).min(1),
});
export type UiActionContribution = z.infer<typeof uiActionContributionSchema>;

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

export const titleSourceSchema = z.enum(["unset", "first_prompt", "agent", "manual", "derived"]);
export type TitleSource = z.infer<typeof titleSourceSchema>;

export const summarySourceSchema = z.enum(["unset", "agent", "manual", "derived"]);
export type SummarySource = z.infer<typeof summarySourceSchema>;

export const autoGenerateMetadataOverrideSchema = z.enum(["default", "on", "off"]);
export type AutoGenerateMetadataOverride = z.infer<typeof autoGenerateMetadataOverrideSchema>;

export const metadataModelSelectionSchema = z.object({
  model: z.string().min(1),
}).nullable();
export type MetadataModelSelection = z.infer<typeof metadataModelSelectionSchema>;

export const appSettingsSchema = z.object({
  autoGenerateSessionMetadata: z.boolean(),
  sessionMetadataModel: metadataModelSelectionSchema,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const updateAppSettingsRequestSchema = z.object({
  autoGenerateSessionMetadata: z.boolean().optional(),
  sessionMetadataModel: metadataModelSelectionSchema.optional(),
});
export type UpdateAppSettingsRequest = z.infer<typeof updateAppSettingsRequestSchema>;

export const sessionIsolationKindSchema = z.enum(["none", "git_worktree"]);
export type SessionIsolationKind = z.infer<typeof sessionIsolationKindSchema>;

export const webSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  piSessionFile: z.string(),
  isolationKind: sessionIsolationKindSchema,
  sourceCwd: z.string().nullable(),
  worktreePath: z.string().nullable(),
  worktreeBranch: z.string().nullable(),
  worktreeBaseCommit: z.string().nullable(),
  worktreeSourceDirty: z.boolean(),
  title: z.string().nullable(),
  titleSource: titleSourceSchema,
  summary: z.string().nullable(),
  summarySource: summarySourceSchema,
  summaryUpdatedAt: z.string().nullable(),
  metadataGenerationCount: z.number().int().nonnegative(),
  metadataLastGeneratedAt: z.string().nullable(),
  autoGenerateMetadataOverride: autoGenerateMetadataOverrideSchema,
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserPrompt: z.string().optional(),
  status: z.enum(["idle", "running", "aborting", "error"]).optional(),
});
export type WebSession = z.infer<typeof webSessionSchema>;

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  isolation: sessionIsolationKindSchema.optional().default("none"),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z.object({
  title: z.string().min(1).max(120).nullable().optional(),
  summary: z.string().min(1).max(600).nullable().optional(),
  autoGenerateMetadataOverride: autoGenerateMetadataOverrideSchema.optional(),
  toolPermissionMode: toolPermissionModeSchema.optional(),
  uiStateJson: z.string().optional(),
});
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const generateSessionMetadataRequestSchema = z.object({
  mode: z.literal("suggest").default("suggest"),
});
export type GenerateSessionMetadataRequest = z.infer<typeof generateSessionMetadataRequestSchema>;

export const sessionMetadataSuggestionSchema = z.object({
  title: z.string().max(60).optional(),
  summary: z.string().max(600).optional(),
  confidence: z.enum(["low", "medium", "high"]),
  deferred: z.boolean().optional(),
  reason: z.string().optional(),
});
export type SessionMetadataSuggestion = z.infer<typeof sessionMetadataSuggestionSchema>;

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

export const fileRawQuerySchema = z.object({
  path: z.string().min(1).max(1000),
});
export type FileRawQuery = z.infer<typeof fileRawQuerySchema>;

export const artifactImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

export const artifactUploadRequestSchema = z.object({
  path: z.string().min(1).max(2000),
  mimeType: artifactImageMimeTypeSchema,
  data: z.string().min(1).max(30 * 1024 * 1024),
});
export type ArtifactUploadRequest = z.infer<typeof artifactUploadRequestSchema>;

export const artifactRawQuerySchema = z.object({
  path: z.string().min(1).max(2000),
});
export type ArtifactRawQuery = z.infer<typeof artifactRawQuerySchema>;

export const artifactUploadResponseSchema = z.object({
  artifactId: z.string(),
  path: z.string(),
  mimeType: artifactImageMimeTypeSchema,
  size: z.number().int().nonnegative(),
  url: z.string(),
});
export type ArtifactUploadResponse = z.infer<typeof artifactUploadResponseSchema>;

export const commandSourceSchema = z.enum(["builtin", "extension", "prompt", "skill"]);
export type CommandSource = z.infer<typeof commandSourceSchema>;

export const commandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: commandSourceSchema,
  argumentHint: z.string().optional(),
  unsupported: z.boolean().optional(),
  sourceInfo: z.unknown().optional(),
});
export type CommandInfo = z.infer<typeof commandInfoSchema>;

export const commandQuerySchema = z.object({
  q: z.string().max(100).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type CommandQuery = z.infer<typeof commandQuerySchema>;

export const commandResponseSchema = z.object({
  query: z.string(),
  commands: z.array(commandInfoSchema),
});
export type CommandResponse = z.infer<typeof commandResponseSchema>;

export type SessionTreeNode = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  role?: string | undefined;
  title: string;
  label?: string | undefined;
  current: boolean;
  children: SessionTreeNode[];
};

export const sessionTreeNodeSchema: z.ZodType<SessionTreeNode> = z.lazy(() => z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  type: z.string(),
  timestamp: z.string(),
  role: z.string().optional(),
  title: z.string(),
  label: z.string().optional(),
  current: z.boolean(),
  children: z.array(sessionTreeNodeSchema),
}));

export const sessionTreeResponseSchema = z.object({
  sessionId: z.string(),
  leafId: z.string().nullable(),
  tree: z.array(sessionTreeNodeSchema),
});
export type SessionTreeResponse = z.infer<typeof sessionTreeResponseSchema>;

export const forkSessionRequestSchema = z.object({
  entryId: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
});
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;

export const navigateTreeRequestSchema = z.object({
  entryId: z.string().min(1),
  summarize: z.boolean().optional().default(false),
});
export type NavigateTreeRequest = z.infer<typeof navigateTreeRequestSchema>;

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

export const contextUsageSchema = z.object({
  tokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive(),
  percent: z.number().nonnegative().nullable(),
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;

export const sessionRuntimeSettingsSchema = z.object({
  model: modelInfoSchema.nullable(),
  availableModels: z.array(modelInfoSchema),
  thinkingLevel: z.string(),
  availableThinkingLevels: z.array(z.string()),
  contextUsage: contextUsageSchema.optional(),
});
export type SessionRuntimeSettings = z.infer<typeof sessionRuntimeSettingsSchema>;

export const questionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const pendingQuestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  question: z.string().min(1),
  recommendation: z.string().optional(),
  options: z.array(questionOptionSchema),
  recommendedOptionIndex: z.number().int().nonnegative().optional(),
  allowCustomAnswer: z.boolean(),
  createdAt: z.string(),
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export const answerQuestionPayloadSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().optional(),
  selectedIndex: z.number().int().nonnegative().nullable().optional(),
  wasCustom: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});
export type AnswerQuestionPayload = z.infer<typeof answerQuestionPayloadSchema>;

export const sessionSnapshotSchema = z.object({
  session: webSessionSchema,
  status: agentStatusSchema,
  messages: z.array(z.unknown()),
  controller: controllerInfoSchema.optional(),
  settings: sessionRuntimeSettingsSchema.optional(),
  pendingQuestion: pendingQuestionSchema.nullable().optional(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const navigateTreeResponseSchema = z.object({
  snapshot: sessionSnapshotSchema,
  editorText: z.string().optional(),
});
export type NavigateTreeResponse = z.infer<typeof navigateTreeResponseSchema>;

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
  z.object({ type: z.literal("session_metadata_update"), session: webSessionSchema }),
  z.object({ type: z.literal("question_update"), question: pendingQuestionSchema.nullable() }),
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
  z.object({ type: z.literal("bash"), command: z.string().min(1), excludeFromContext: z.boolean().optional() }),
  z.object({ type: z.literal("steer"), text: z.string().min(1), images: z.array(z.string()).optional() }),
  z.object({ type: z.literal("follow_up"), text: z.string().min(1), images: z.array(z.string()).optional() }),
  z.object({ type: z.literal("cancel_queued_message"), queue: z.enum(["steering", "followUp"]), index: z.number().int().nonnegative(), text: z.string().min(1).optional() }),
  z.object({ type: z.literal("answer_question"), payload: answerQuestionPayloadSchema }),
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
