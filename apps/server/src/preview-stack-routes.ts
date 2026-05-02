import { type FastifyInstance } from "fastify";
import type { MetadataStore } from "./metadata-store.js";
import type { PreviewStackManager } from "./preview-stacks.js";

export type PreviewStackRouteDeps = {
  store: MetadataStore;
  previewStacks: PreviewStackManager;
};

export function registerPreviewStackRoutes(app: FastifyInstance, deps: PreviewStackRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/sessions/:id/preview-stack", async (request, reply) => {
    const session = deps.store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return deps.previewStacks.status(session);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/preview-stack/start", async (request, reply) => {
    const session = deps.store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    try {
      return await deps.previewStacks.start(session);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/preview-stack/stop", async (request, reply) => {
    const session = deps.store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    await deps.previewStacks.stop(session.id);
    return deps.previewStacks.status(session);
  });
}
