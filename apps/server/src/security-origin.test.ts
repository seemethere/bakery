import { describe, expect, test } from "bun:test";
import { isBrowserOriginAllowed, normalizeOrigin, parseAllowedOrigins } from "./security-origin.js";

describe("browser origin policy", () => {
  test("allows non-browser requests without an Origin header", () => {
    expect(isBrowserOriginAllowed({
      origin: undefined,
      requestHost: "127.0.0.1:3141",
      authRequired: false,
      allowedOrigins: [],
    })).toBe(true);
  });

  test("allows default Bakery dev origins", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"]) {
      expect(isBrowserOriginAllowed({
        origin,
        requestHost: "127.0.0.1:3141",
        authRequired: false,
        allowedOrigins: [],
      })).toBe(true);
    }
  });

  test("denies unrelated browser origins in no-token mode", () => {
    expect(isBrowserOriginAllowed({
      origin: "https://evil.example",
      requestHost: "127.0.0.1:3141",
      authRequired: false,
      allowedOrigins: [],
    })).toBe(false);
  });

  test("denies arbitrary localhost ports unless explicitly configured", () => {
    expect(isBrowserOriginAllowed({
      origin: "http://127.0.0.1:9123",
      requestHost: "127.0.0.1:3141",
      authRequired: false,
      allowedOrigins: [],
    })).toBe(false);
    expect(isBrowserOriginAllowed({
      origin: "http://127.0.0.1:9123",
      requestHost: "127.0.0.1:3141",
      authRequired: false,
      allowedOrigins: ["http://127.0.0.1:9123"],
    })).toBe(true);
  });

  test("parses configured origins and ignores invalid entries", () => {
    expect(parseAllowedOrigins(" http://127.0.0.1:45173,not a url,https://bakery.local ")).toEqual([
      "http://127.0.0.1:45173",
      "https://bakery.local",
    ]);
  });

  test("allows same-host Vite origin in token-protected LAN mode", () => {
    expect(isBrowserOriginAllowed({
      origin: "http://192.168.1.20:5173",
      requestHost: "192.168.1.20:3141",
      authRequired: true,
      allowedOrigins: [],
    })).toBe(true);
  });

  test("allows same-origin API requests in token-protected LAN mode", () => {
    expect(isBrowserOriginAllowed({
      origin: "http://192.168.1.20:3141",
      requestHost: "192.168.1.20:3141",
      authRequired: true,
      allowedOrigins: [],
    })).toBe(true);
  });

  test("denies unrelated LAN origins even in token mode", () => {
    expect(isBrowserOriginAllowed({
      origin: "http://192.168.1.99:5173",
      requestHost: "192.168.1.20:3141",
      authRequired: true,
      allowedOrigins: [],
    })).toBe(false);
  });

  test("denies malformed origins", () => {
    expect(normalizeOrigin("http://127.0.0.1:5173/path")).toBeNull();
    expect(isBrowserOriginAllowed({
      origin: "null",
      requestHost: "127.0.0.1:3141",
      authRequired: false,
      allowedOrigins: [],
    })).toBe(false);
  });
});
