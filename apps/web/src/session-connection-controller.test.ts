import { describe, expect, test } from "bun:test";
import { reconnectDelayMs, sessionWebSocketUrl } from "./session-connection-controller";

describe("session connection controller", () => {
  test("builds websocket urls from http api urls", () => {
    const url = sessionWebSocketUrl("http://127.0.0.1:3141", "abc", "token", "client-1");

    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/api/sessions/abc/ws");
    expect(url.searchParams.get("token")).toBe("token");
    expect(url.searchParams.get("clientId")).toBe("client-1");
  });

  test("caps reconnect backoff", () => {
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(10)).toBe(8000);
  });
});
