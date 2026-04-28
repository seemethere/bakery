export type AppRoute =
  | { kind: "home" }
  | { kind: "sessions" }
  | { kind: "session"; sessionId: string }
  | { kind: "unknown"; path: string };

export function parseAppRoute(pathname: string): AppRoute {
  const path = pathname || "/";
  if (path === "/" || path === "") return { kind: "home" };
  if (path === "/sessions" || path === "/sessions/") return { kind: "sessions" };
  const match = /^\/sessions\/([^/]+)\/?$/.exec(path);
  if (!match) return { kind: "unknown", path };
  try {
    const sessionId = decodeURIComponent(match[1] ?? "").trim();
    return sessionId ? { kind: "session", sessionId } : { kind: "unknown", path };
  } catch {
    return { kind: "unknown", path };
  }
}

export function sessionsRoutePath(): string {
  return "/sessions";
}

export function sessionRoutePath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
