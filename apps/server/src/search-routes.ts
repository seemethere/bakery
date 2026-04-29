import {
  commandQuerySchema,
  fileCompleteQuerySchema,
  fileSearchQuerySchema,
} from "@pi-web-agent/protocol";
import type { FastifyInstance } from "fastify";
import { completeFiles, searchFiles } from "./file-search.js";
import type { MetadataStore } from "./metadata-store.js";
import type { PiSessionRunner } from "./pi-runner.js";

type SearchRouteDeps = {
  store: MetadataStore;
  runner: PiSessionRunner;
};

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const { store, runner } = deps;

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string | number } }>("/api/sessions/:id/commands", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = commandQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const handle = await runner.createSession({
        id: session.id,
        cwd: session.cwd,
        piSessionFile: session.piSessionFile,
      });
      const query = parsed.data.q.toLowerCase();
      const commands = handle.getCommands()
        .filter((command) => !query || command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query))
        .sort((a, b) => {
          const aStarts = query && a.name.toLowerCase().startsWith(query) ? 0 : 1;
          const bStarts = query && b.name.toLowerCase().startsWith(query) ? 0 : 1;
          return aStarts - bStarts || a.name.localeCompare(b.name);
        })
        .slice(0, parsed.data.limit);
      return { query: parsed.data.q, commands };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string | number } }>("/api/sessions/:id/files/search", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = fileSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const files = await searchFiles(session.cwd, parsed.data.q, parsed.data.limit);
    return { query: parsed.data.q, files };
  });

  app.get<{ Params: { id: string }; Querystring: { prefix?: string; limit?: string | number } }>("/api/sessions/:id/files/complete", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const parsed = fileCompleteQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const files = await completeFiles(session.cwd, parsed.data.prefix, parsed.data.limit);
    return { prefix: parsed.data.prefix, files };
  });
}
