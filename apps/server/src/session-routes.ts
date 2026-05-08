import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createSessionRequestSchema,
  forkSessionRequestSchema,
  navigateTreeRequestSchema,
  type SessionTreeNode,
  type WebSession,
} from "@pi-web-agent/protocol";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { createGitWorktreeSession } from "./git-worktrees.js";
import type { MetadataStore } from "./metadata-store.js";
import { messageText } from "./metadata-routes.js";
import type { PiSessionRunner } from "./pi-runner.js";
import { compactWorkflowLaunchText } from "./workflow-skills.js";
import { assertAllowedCwd } from "./workspaces.js";

type SessionRouteDeps = {
  config: ServerConfig;
  workspaceRoots: string[];
  store: MetadataStore;
  runner: PiSessionRunner;
  disposeHub(sessionId: string): Promise<boolean>;
};

type PiSessionTreeNode = ReturnType<SessionManager["getTree"]>[number];

function flattenTree(nodes: PiSessionTreeNode[]): PiSessionTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

async function enrichSession(session: WebSession, deps: SessionRouteDeps): Promise<WebSession> {
  const handle = deps.runner.getSession(session.id);
  let status: WebSession["status"] | undefined;
  if (handle) status = (await handle.snapshot(session)).status;

  try {
    const manager = handle?.session.sessionManager ?? SessionManager.open(session.piSessionFile, deps.config.sessionDir, session.cwd);
    const entries = flattenTree(manager.getTree())
      .map((node) => node.entry)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const last = entries.at(-1);
    const lastUser = [...entries].reverse().find((entry: SessionEntry) => {
      if (entry.type !== "message") return false;
      const message = entry.message as { role?: string };
      return message.role === "user";
    });
    const lastUserText = lastUser?.type === "message" ? messageText((lastUser.message as { content?: unknown }).content) : "";
    const lastUserPrompt = lastUserText ? (compactWorkflowLaunchText(lastUserText) ?? lastUserText.replace(/\s+/g, " ").trim().slice(0, 160)) : undefined;
    return {
      ...session,
      lastActivityAt: last?.timestamp ?? session.lastOpenedAt,
      lastUserPrompt: lastUserPrompt || undefined,
      status: status ?? "idle",
    };
  } catch {
    return { ...session, lastActivityAt: session.lastOpenedAt, status: status ?? "idle" };
  }
}

function entryTitle(entry: SessionEntry): { title: string; role?: string } {
  if (entry.type === "message") {
    const message = entry.message as { role?: string; content?: unknown };
    const role = String(message.role ?? "message");
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join(" ")
        : "";
    const titleText = compactWorkflowLaunchText(text, 80) ?? text.replace(/\s+/g, " ").trim().slice(0, 80);
    return { role, title: `${role}: ${titleText || "(empty)"}` };
  }
  if (entry.type === "compaction") return { title: `compaction: ${entry.summary.slice(0, 80)}` };
  if (entry.type === "branch_summary") return { title: `branch summary: ${entry.summary.slice(0, 80)}` };
  if (entry.type === "model_change") return { title: `model: ${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { title: `thinking: ${entry.thinkingLevel}` };
  if (entry.type === "session_info") return { title: `name: ${entry.name ?? "unnamed"}` };
  if (entry.type === "label") return { title: `label: ${entry.label ?? "cleared"}` };
  return { title: entry.type };
}

function mapTreeNode(node: PiSessionTreeNode, leafId: string | null): SessionTreeNode {
  const formatted = entryTitle(node.entry);
  return {
    id: node.entry.id,
    parentId: node.entry.parentId,
    type: node.entry.type,
    timestamp: node.entry.timestamp,
    role: formatted.role,
    title: node.label ? `${formatted.title} · ${node.label}` : formatted.title,
    label: node.label,
    current: node.entry.id === leafId,
    children: node.children.map((child) => mapTreeNode(child, leafId)),
  };
}

export async function createForkFile(sourceFile: string, cwd: string, entryId: string, sessionDir: string, position: "auto" | "before" | "at" = "auto"): Promise<{ piSessionFile: string; editorText?: string }> {
  const manager = SessionManager.open(sourceFile, sessionDir, cwd);
  const entry = manager.getEntry(entryId);
  if (!entry) throw new Error(`Entry not found: ${entryId}`);
  const isUserMessage = entry.type === "message" && (entry.message as { role?: string }).role === "user";
  const resolvedPosition = position === "auto" ? (isUserMessage ? "before" : "at") : position;
  const branchTargetId = resolvedPosition === "before" ? entry.parentId : entryId;
  const branch = branchTargetId ? manager.getBranch(branchTargetId) : [];
  const editorText = resolvedPosition === "before" && isUserMessage ? messageText((entry.message as { content?: unknown }).content) : undefined;
  const timestamp = new Date().toISOString();
  const piSessionId = crypto.randomUUID();
  const targetFile = resolve(sessionDir, `${piSessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: piSessionId,
    timestamp,
    cwd,
    parentSession: sourceFile,
  };
  const lines = [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(targetFile, lines, "utf8");
  return editorText ? { piSessionFile: targetFile, editorText } : { piSessionFile: targetFile };
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { config, workspaceRoots, store, runner } = deps;

  app.get("/api/sessions", async () => Promise.all(store.listSessions().map((session) => enrichSession(session, deps))));

  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const sourceCwd = await assertAllowedCwd(parsed.data.cwd, workspaceRoots);
      const id = crypto.randomUUID();
      const piSessionFile = resolve(config.sessionDir, `${id}.jsonl`);
      if (parsed.data.isolation === "git_worktree") {
        const worktree = await createGitWorktreeSession({ sourceCwd, sessionId: id, worktreeDir: config.worktreeDir });
        const session = store.createSession({
          id,
          cwd: worktree.cwd,
          piSessionFile,
          title: parsed.data.title ?? null,
          titleSource: parsed.data.title ? "manual" : "unset",
          isolationKind: "git_worktree",
          sourceCwd: worktree.sourceCwd,
          worktreePath: worktree.worktreePath,
          worktreeBranch: worktree.worktreeBranch,
          worktreeBaseCommit: worktree.worktreeBaseCommit,
          worktreeSourceDirty: worktree.worktreeSourceDirty,
        });
        return reply.code(201).send(session);
      }
      const session = store.createSession({ id, cwd: sourceCwd, piSessionFile, title: parsed.data.title ?? null, titleSource: parsed.data.title ? "manual" : "unset" });
      return reply.code(201).send(session);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    store.touchSession(session.id);
    return store.getSession(session.id) ?? session;
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (!store.deleteSession(request.params.id)) return reply.code(404).send({ error: "session not found" });
    const disposedHub = await deps.disposeHub(request.params.id);
    if (!disposedHub) await runner.disposeSession(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/tree", async (request, reply) => {
    const webSession = store.getSession(request.params.id);
    if (!webSession) return reply.code(404).send({ error: "session not found" });
    try {
      const handle = runner.getSession(webSession.id);
      const manager = handle?.session.sessionManager ?? SessionManager.open(webSession.piSessionFile, config.sessionDir, webSession.cwd);
      const leafId = manager.getLeafId();
      return { sessionId: webSession.id, leafId, tree: manager.getTree().map((node) => mapTreeNode(node, leafId)) };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/tree/navigate", async (request, reply) => {
    const parsed = navigateTreeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const webSession = store.getSession(request.params.id);
    if (!webSession) return reply.code(404).send({ error: "session not found" });
    try {
      const handle = await runner.createSession({
        id: webSession.id,
        cwd: webSession.cwd,
        piSessionFile: webSession.piSessionFile,
      });
      if (handle.session.isStreaming) return reply.code(409).send({ error: "cannot navigate while agent is running" });
      const result = await handle.session.navigateTree(parsed.data.entryId, { summarize: parsed.data.summarize });
      if (result.cancelled) return reply.code(409).send({ error: "navigation cancelled" });
      const snapshot = await handle.snapshot(webSession);
      return { snapshot, editorText: result.editorText };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/fork", async (request, reply) => {
    const parsed = forkSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const source = store.getSession(request.params.id);
    if (!source) return reply.code(404).send({ error: "session not found" });
    try {
      const id = crypto.randomUUID();
      const fork = await createForkFile(source.piSessionFile, source.cwd, parsed.data.entryId, config.sessionDir, parsed.data.position);
      const title = parsed.data.title ?? `Fork of ${source.title ?? source.cwd}`;
      const session = store.createSession({ id, cwd: source.cwd, piSessionFile: fork.piSessionFile, title, titleSource: parsed.data.title ? "manual" : "derived", summary: source.summary, summarySource: source.summary ? "derived" : "unset" });
      return reply.code(201).send({ session, editorText: fork.editorText });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
