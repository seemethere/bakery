import {
  generateSessionMetadataRequestSchema,
  updateSessionRequestSchema,
  type SessionMetadataSuggestion,
  type WebSession,
} from "@pi-web-agent/protocol";
import { completeSimple, type Message, type Model, type SimpleStreamOptions, type ThinkingLevel } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import type { MetadataStore } from "./metadata-store.js";
import type { PiSessionRunner, SessionHandle } from "./pi-runner.js";
import { assertAllowedSessionWorkspace, type WorkspacePermissionScope } from "./workspaces.js";

export type MetadataUpdateBroadcaster = {
  broadcastMetadataUpdate(session: WebSession): void;
};

export type MetadataRouteDeps = {
  config: ServerConfig;
  store: MetadataStore;
  runner: PiSessionRunner;
  getWorkspacePermissionScope(): WorkspacePermissionScope;
  getBroadcaster(sessionId: string): MetadataUpdateBroadcaster | undefined;
};

export type GenerateSessionDetailsOptions = {
  guidance?: string;
  replaceManual?: boolean;
};

export type GenerateSessionDetailsResult = {
  suggestion: SessionMetadataSuggestion;
  applied: Array<"title" | "summary">;
  skipped: Array<{ field: "title" | "summary"; reason: string }>;
  session?: WebSession;
};

type PiSessionTreeNode = ReturnType<SessionManager["getTree"]>[number];

function flattenTree(nodes: PiSessionTreeNode[]): PiSessionTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")
    .filter(Boolean)
    .join(" ");
}

export function cleanMetadataText(value: string, max: number): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:bearer\s+)[a-z0-9._~+/-]+=*/gi, "bearer [redacted]")
    .replace(/[a-z0-9]{32,}/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isGenericPrompt(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:ok(?:ay)?|sure|sounds good|let'?s do it|go on|continue|next|next up|next thing)(?: please)?$/.test(normalized)) return true;
  if (/^(?:give me (?:a )?sense of )?(?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  if (/^(?:nice|okay|alright|ok) (?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  return false;
}

function titleFromPrompt(text: string): string | null {
  let cleaned = cleanMetadataText(text, 120)
    .replace(/^(?:i think|i want to|can we|could we|let'?s|please)\s+/i, "")
    .replace(/\b(?:kind of|maybe|even|still|a bit)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isGenericPrompt(cleaned) || cleaned.length < 8) return null;

  const lower = cleaned.toLowerCase();
  if (/session/.test(lower) && /summar/.test(lower) && /title|naming|name/.test(lower)) return "Improve session titles and summaries";
  if (/session/.test(lower) && /title|naming|name/.test(lower)) return "Fix session title naming";
  if (/summary|summar/.test(lower)) return "Improve session summaries";
  if (/queued|follow.?up|steer/.test(lower)) return "Refine queued follow-up controls";
  if (/tool/.test(lower) && /output|terminal|viewport/.test(lower)) return "Tune tool output ergonomics";
  if (/context/.test(lower) && /usage|availability|window/.test(lower)) return "Add context usage indicator";

  cleaned = cleaned.replace(/[.!?]+$/, "");
  return cleaned.slice(0, 60);
}

export function firstPromptTitle(text: string): string | null {
  return titleFromPrompt(text);
}

function sessionEntries(session: WebSession, deps: MetadataRouteDeps): SessionEntry[] {
  const handle = deps.runner.getSession(session.id);
  if (!handle && session.cwd === null) return [];
  const manager = handle?.session.sessionManager ?? SessionManager.open(session.piSessionFile, deps.config.sessionDir, session.cwd ?? undefined);
  return flattenTree(manager.getTree()).map((node) => node.entry).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function transcriptSignals(session: WebSession, deps: MetadataRouteDeps): { users: string[]; assistants: string[]; compactions: string[] } {
  const users: string[] = [];
  const assistants: string[] = [];
  const compactions: string[] = [];
  for (const entry of sessionEntries(session, deps)) {
    if (entry.type === "message") {
      const message = entry.message as { role?: string; content?: unknown };
      const text = cleanMetadataText(messageText(message.content), 360);
      if (!text) continue;
      if (message.role === "user") users.push(text);
      if (message.role === "assistant") assistants.push(text);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      compactions.push(cleanMetadataText(entry.summary, 360));
    }
  }
  return { users, assistants, compactions };
}

function generateHeuristicMetadata(session: WebSession, deps: MetadataRouteDeps): SessionMetadataSuggestion {
  let signals: ReturnType<typeof transcriptSignals>;
  try {
    signals = transcriptSignals(session, deps);
  } catch (error) {
    return { confidence: "low", deferred: true, reason: error instanceof Error ? error.message : String(error) };
  }
  const meaningfulUsers = signals.users.filter((text) => !isGenericPrompt(text));
  const basis = meaningfulUsers[0] ?? "";
  const title = basis ? titleFromPrompt(basis)?.replace(/[.!?]+$/, "") || undefined : undefined;

  // The local heuristic is intentionally title-only. Prompt concatenation made poor summaries
  // that looked authoritative; useful summaries should come from the model-backed generator.
  if (!title) return { confidence: "low", deferred: true, reason: "Not enough specific session context for a useful title yet." };
  return { title, confidence: "medium", reason: "Summary generation needs the model-backed generator." };
}

function metadataPromptMessages(session: WebSession, deps: MetadataRouteDeps, guidance?: string): Message[] {
  const messages = sessionEntries(session, deps)
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      const message = entry.message as { role?: string; content?: unknown; timestamp?: unknown };
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
      if (!role) return null;
      const text = cleanMetadataText(messageText(message.content), role === "user" ? 800 : 1200);
      if (!text) return null;
      return { role, text, timestamp: Date.parse(entry.timestamp) || Date.now() };
    })
    .filter((message): message is { role: "user" | "assistant"; text: string; timestamp: number } => Boolean(message));

  return messages.slice(-24).map((message) => {
    if (message.role === "user") return { role: "user", content: message.text, timestamp: message.timestamp } satisfies Message;
    return {
      role: "assistant",
      content: [{ type: "text", text: message.text }],
      api: "metadata" as const,
      provider: "metadata" as const,
      model: "metadata",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: message.timestamp,
    } satisfies Message;
  });
}

function parseMetadataJson(text: string): { title?: string; summary?: string } {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  const jsonText = firstBrace >= 0 && lastBrace > firstBrace ? stripped.slice(firstBrace, lastBrace + 1) : stripped;
  const parsed = JSON.parse(jsonText) as { title?: unknown; summary?: unknown };
  const title = typeof parsed.title === "string" ? cleanMetadataText(parsed.title, 60).replace(/[.!?]+$/, "") : undefined;
  const summary = typeof parsed.summary === "string" ? cleanMetadataText(parsed.summary, 600) : undefined;
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
  };
}

async function resolveMetadataModel(handle: SessionHandle, deps: MetadataRouteDeps): Promise<{ model: Model<any>; apiKey?: string; headers?: Record<string, string> }> {
  const settings = deps.store.getSettings();
  const available = (await handle.session.modelRegistry.getAvailable()).filter((model) => !deps.config.modelPolicy.allowedModels || deps.config.modelPolicy.allowedModels.includes(`${model.provider}/${model.id}`));
  const selectedModelId = settings.sessionMetadataModel?.model ?? deps.config.modelPolicy.defaultModel ?? (handle.session.model ? `${handle.session.model.provider}/${handle.session.model.id}` : undefined);
  const selected = selectedModelId ? available.find((model) => `${model.provider}/${model.id}` === selectedModelId) : undefined;
  const model = selected ?? (handle.session.model && available.find((candidate) => candidate.provider === handle.session.model?.provider && candidate.id === handle.session.model?.id)) ?? available[0];
  if (!model) throw new Error("No authenticated metadata model is available. Configure a model, then try ✨ again.");
  const auth = await handle.session.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  return {
    model,
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers ? { headers: auth.headers } : {}),
  };
}

async function generateModelBackedMetadata(session: WebSession, deps: MetadataRouteDeps, guidance?: string): Promise<SessionMetadataSuggestion> {
  const heuristic = generateHeuristicMetadata(session, deps);
  const messages = metadataPromptMessages(session, deps, guidance);
  const meaningfulUsers = messages.filter((message) => message.role === "user" && !isGenericPrompt(messageText(message.content))).length;
  if (messages.length < 2 || meaningfulUsers === 0) return heuristic.deferred ? heuristic : { ...heuristic, deferred: true, reason: "Not enough session context for a useful summary yet." };
  if (session.cwd === null) return { ...heuristic, deferred: true, reason: "Session has no workspace; metadata generation requires one." };

  await assertAllowedSessionWorkspace(session, deps.getWorkspacePermissionScope());
  const handle = await deps.runner.createSession({ id: session.id, cwd: session.cwd, piSessionFile: session.piSessionFile });
  const { model, apiKey, headers } = await resolveMetadataModel(handle, deps);
  const abort = AbortSignal.timeout(60_000);
  const completionOptions: SimpleStreamOptions = {
    maxTokens: 450,
    signal: abort,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(model.reasoning && deps.config.modelPolicy.defaultThinkingLevel !== "off" ? { reasoning: deps.config.modelPolicy.defaultThinkingLevel as ThinkingLevel } : {}),
  };
  const response = await completeSimple(model, {
    systemPrompt: "You generate concise metadata for a coding-agent web session. Return only valid JSON. Do not mention that you are an AI. Do not add markdown.",
    messages: [
      ...messages,
      {
        role: "user",
        content: [
          "Create session metadata for the preceding transcript. Return JSON exactly in this shape: {\"title\":\"3-7 words, <=60 chars\",\"summary\":\"1-3 plain-text sentences, <=600 chars, specific accomplishments and current state\"}.",
          "If the transcript is generic, still summarize only concrete context present.",
          guidance ? `Operator guidance: ${cleanMetadataText(guidance, 500)}` : "",
        ].filter(Boolean).join(" "),
        timestamp: Date.now(),
      },
    ],
  }, completionOptions);
  if (response.stopReason === "error") throw new Error(response.errorMessage || "Metadata generation failed");
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const parsed = parseMetadataJson(text);
  const title = parsed.title || heuristic.title;
  if (!title && !parsed.summary) return { confidence: "low", deferred: true, reason: "The metadata model did not return a usable suggestion." };
  return {
    ...(title ? { title } : {}),
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    confidence: parsed.summary ? "high" : heuristic.confidence,
    reason: `Generated with ${model.provider}/${model.id}. Review before applying.`,
  };
}

export async function generateSessionMetadataSuggestion(session: WebSession, deps: MetadataRouteDeps, options: GenerateSessionDetailsOptions = {}): Promise<SessionMetadataSuggestion> {
  return deps.config.fakeAgent ? generateHeuristicMetadata(session, deps) : await generateModelBackedMetadata(session, deps, options.guidance);
}

export function applySessionMetadataSuggestion(session: WebSession, deps: MetadataRouteDeps, suggestion: SessionMetadataSuggestion, options: GenerateSessionDetailsOptions = {}): GenerateSessionDetailsResult {
  const applied: GenerateSessionDetailsResult["applied"] = [];
  const skipped: GenerateSessionDetailsResult["skipped"] = [];
  const patch: Parameters<MetadataStore["updateSession"]>[1] = {};
  if (suggestion.title) {
    if (!options.replaceManual && session.titleSource === "manual") skipped.push({ field: "title", reason: "manual title protected" });
    else {
      patch.title = suggestion.title;
      patch.titleSource = "agent";
      applied.push("title");
    }
  }
  if (suggestion.summary) {
    if (!options.replaceManual && session.summarySource === "manual") skipped.push({ field: "summary", reason: "manual summary protected" });
    else {
      patch.summary = suggestion.summary;
      patch.summarySource = "agent";
      applied.push("summary");
    }
  }
  if (applied.length > 0) patch.incrementGenerationCount = true;
  const updated = applied.length > 0 ? deps.store.updateSession(session.id, patch) : session;
  if (updated && applied.length > 0) deps.getBroadcaster(session.id)?.broadcastMetadataUpdate(updated);
  return { suggestion, applied, skipped, ...(updated ? { session: updated } : {}) };
}

export async function generateAndApplySessionDetails(session: WebSession, deps: MetadataRouteDeps, options: GenerateSessionDetailsOptions = {}): Promise<GenerateSessionDetailsResult> {
  const suggestion = await generateSessionMetadataSuggestion(session, deps, options);
  if (suggestion.deferred) return { suggestion, applied: [], skipped: [] };
  return applySessionMetadataSuggestion(session, deps, suggestion, options);
}

export function registerMetadataRoutes(app: FastifyInstance, deps: MetadataRouteDeps): void {
  const { store, runner, config, getBroadcaster } = deps;

  app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const parsed = updateSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const existing = store.getSession(request.params.id);
    if (!existing) return reply.code(404).send({ error: "session not found" });

    if (Object.hasOwn(parsed.data, "title")) store.updateSession(existing.id, { title: parsed.data.title ?? null, titleSource: parsed.data.title ? "manual" : "unset" });
    if (Object.hasOwn(parsed.data, "summary")) store.updateSession(existing.id, { summary: parsed.data.summary ?? null, summarySource: parsed.data.summary ? "manual" : "unset" });
    if (parsed.data.autoGenerateMetadataOverride) store.updateSession(existing.id, { autoGenerateMetadataOverride: parsed.data.autoGenerateMetadataOverride });
    if (Object.hasOwn(parsed.data, "pinned") && parsed.data.pinned !== undefined) store.updateSession(existing.id, { pinned: parsed.data.pinned });
    const updatedAfterMetadata = store.getSession(existing.id);
    const handle = runner.getSession(existing.id);
    if (handle && Object.hasOwn(parsed.data, "title") && parsed.data.title) handle.setSessionName(parsed.data.title);
    const broadcaster = getBroadcaster(existing.id);
    if (broadcaster && updatedAfterMetadata) broadcaster.broadcastMetadataUpdate(updatedAfterMetadata);
    store.updatePreferences(existing.id, {
      ...(parsed.data.toolPermissionMode ? { toolPermissionMode: parsed.data.toolPermissionMode } : {}),
      ...(parsed.data.uiStateJson ? { uiStateJson: parsed.data.uiStateJson } : {}),
    });
    return store.getSession(existing.id);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/metadata/generate", async (request, reply) => {
    const parsed = generateSessionMetadataRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const handle = runner.getSession(session.id);
    if (handle && (await handle.snapshot(session)).status !== "idle") return reply.code(409).send({ error: "metadata generation is available when the session is idle" });
    try {
      const suggestion = await generateSessionMetadataSuggestion(session, deps, parsed.data.guidance ? { guidance: parsed.data.guidance } : {});
      if (!suggestion.deferred) {
        const updated = store.updateSession(session.id, { incrementGenerationCount: true });
        const broadcaster = getBroadcaster(session.id);
        if (updated && broadcaster) broadcaster.broadcastMetadataUpdate(updated);
      }
      return suggestion;
    } catch (error) {
      request.log.warn({ error }, "metadata generation failed");
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
