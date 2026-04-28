import { describe, expect, test } from "bun:test";
import { parseAppRoute, sessionsRoutePath, sessionRoutePath, settingsRoutePath } from "./router";

describe("app routes", () => {
  test("parses the home route", () => {
    expect(parseAppRoute("/")).toEqual({ kind: "home" });
    expect(parseAppRoute("")).toEqual({ kind: "home" });
  });

  test("parses sessions list routes", () => {
    expect(parseAppRoute("/sessions")).toEqual({ kind: "sessions" });
    expect(parseAppRoute("/sessions/")).toEqual({ kind: "sessions" });
    expect(sessionsRoutePath()).toBe("/sessions");
  });

  test("parses settings routes", () => {
    expect(parseAppRoute("/settings")).toEqual({ kind: "settings" });
    expect(parseAppRoute("/settings/")).toEqual({ kind: "settings" });
    expect(settingsRoutePath()).toBe("/settings");
  });

  test("parses session routes", () => {
    expect(parseAppRoute("/sessions/abc-123")).toEqual({ kind: "session", sessionId: "abc-123" });
    expect(parseAppRoute("/sessions/abc-123/")).toEqual({ kind: "session", sessionId: "abc-123" });
  });

  test("decodes and builds session paths", () => {
    const id = "session id/with slash";
    const path = sessionRoutePath(id);
    expect(path).toBe("/sessions/session%20id%2Fwith%20slash");
    expect(parseAppRoute(path)).toEqual({ kind: "session", sessionId: id });
  });

  test("preserves unknown paths", () => {
    expect(parseAppRoute("/settings/extra")).toEqual({ kind: "unknown", path: "/settings/extra" });
    expect(parseAppRoute("/sessions//")).toEqual({ kind: "unknown", path: "/sessions//" });
  });
});
