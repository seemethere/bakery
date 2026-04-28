export type AppRoute =
  | { kind: "home" }
  | { kind: "session"; sessionId: string }
  | { kind: "unknown"; path: string };

export function parseAppRoute(pathname: string): AppRoute {
  const path = pathname || "/";
  if (path === "/" || path === "") return { kind: "home" };
  const match = /^\/sessions\/([^/]+)\/?$/.exec(path);
  if (!match) return { kind: "unknown", path };
  try {
    const sessionId = decodeURIComponent(match[1] ?? "").trim();
    return sessionId ? { kind: "session", sessionId } : { kind: "unknown", path };
  } catch {
    return { kind: "unknown", path };
  }
}

export function sessionRoutePath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
