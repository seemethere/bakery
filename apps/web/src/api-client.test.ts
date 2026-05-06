import { describe, expect, test } from "bun:test";
import { ApiClientError, arraySchema, requestJson, type JsonSchema } from "./api-client";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const unknownSchema: JsonSchema<unknown> = { safeParse: (value) => ({ success: true, data: value }) };
const okSchema: JsonSchema<{ ok: true }> = {
  safeParse: (value) => typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true
    ? { success: true, data: { ok: true } }
    : { success: false, error: { message: "Expected { ok: true }" } },
};
const stringArrayObjectSchema: JsonSchema<{ sessions: string[] }> = {
  safeParse: (value) => {
    const sessions = typeof value === "object" && value !== null ? (value as { sessions?: unknown }).sessions : undefined;
    return Array.isArray(sessions) && sessions.every((item) => typeof item === "string")
      ? { success: true, data: { sessions } }
      : { success: false, error: { message: "Expected string sessions" } };
  },
};
const pathObjectSchema: JsonSchema<{ path: string }> = {
  safeParse: (value) => typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string"
    ? { success: true, data: { path: (value as { path: string }).path } }
    : { success: false, error: { message: "Expected path string" } },
};

describe("requestJson", () => {
  test("validates successful JSON responses with the supplied schema", async () => {
    const result = await requestJson({
      apiBase: "http://example.test",
      path: "/api/config",
      schema: okSchema,
      fetchFn: async () => jsonResponse({ ok: true }),
    });

    expect(result).toEqual({ ok: true });
  });

  test("reports response shape drift with the endpoint path", async () => {
    await expect(requestJson({
      apiBase: "http://example.test",
      path: "/api/sessions",
      schema: stringArrayObjectSchema,
      fetchFn: async () => jsonResponse({ sessions: [1] }),
    })).rejects.toThrow(/Invalid response from \/api\/sessions/);
  });

  test("validates array schemas without requiring callers to import zod", async () => {
    const result = await requestJson({
      apiBase: "http://example.test",
      path: "/api/workspaces",
      schema: arraySchema(pathObjectSchema),
      fetchFn: async () => jsonResponse([{ path: "/workspace" }]),
    });

    expect(result).toEqual([{ path: "/workspace" }]);
  });

  test("preserves existing HTTP error messages", async () => {
    await expect(requestJson({
      apiBase: "http://example.test",
      path: "/api/settings",
      schema: unknownSchema,
      fetchFn: async () => new Response("nope", { status: 500 }),
    })).rejects.toThrow("500: nope");
  });

  test("merges auth and request headers", async () => {
    const seenHeaders: Record<string, string> = {};
    await requestJson({
      apiBase: "http://example.test",
      path: "/api/workspaces",
      schema: arraySchema(pathObjectSchema),
      headers: { Authorization: "Bearer token" },
      init: { headers: { "X-Test": "1" } },
      fetchFn: async (_url, init) => {
        const headers = new Headers(init?.headers);
        headers.forEach((value, key) => { seenHeaders[key] = value; });
        return jsonResponse([]);
      },
    });

    expect(seenHeaders.authorization).toBe("Bearer token");
    expect(seenHeaders["x-test"]).toBe("1");
  });

  test("exposes ApiClientError metadata", async () => {
    try {
      await requestJson({
        apiBase: "http://example.test",
        path: "/api/config",
        schema: okSchema,
        fetchFn: async () => new Response("not json"),
      });
      throw new Error("expected requestJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect((error as ApiClientError).path).toBe("/api/config");
    }
  });
});
