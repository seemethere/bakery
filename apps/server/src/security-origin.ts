const defaultBakeryUiOrigins = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://[::1]:5173",
];

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter((origin): origin is string => Boolean(origin)))];
}

function hostFromHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function originHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function isSameHostDevOrigin(origin: string, requestHost: string | undefined): boolean {
  const requestHostname = hostFromHostHeader(requestHost);
  const sourceHostname = originHost(origin);
  if (!requestHostname || !sourceHostname || requestHostname !== sourceHostname) return false;
  try {
    const url = new URL(origin);
    return url.port === "5173" || url.host === requestHost;
  } catch {
    return false;
  }
}

export function isBrowserOriginAllowed(options: {
  origin: string | undefined;
  requestHost: string | undefined;
  authRequired: boolean;
  allowedOrigins: readonly string[];
}): boolean {
  if (!options.origin) return true;
  const origin = normalizeOrigin(options.origin);
  if (!origin) return false;
  if (defaultBakeryUiOrigins.includes(origin)) return true;
  if (options.allowedOrigins.includes(origin)) return true;
  return options.authRequired && isSameHostDevOrigin(origin, options.requestHost);
}
