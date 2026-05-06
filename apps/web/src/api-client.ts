type ParseResult<T> = { success: true; data: T } | { success: false; error: { message: string; flatten?: () => unknown } };

export type JsonSchema<T> = {
  safeParse: (value: unknown) => ParseResult<T>;
};

export function arraySchema<T>(itemSchema: JsonSchema<T>): JsonSchema<T[]> {
  return {
    safeParse(value: unknown): ParseResult<T[]> {
      if (!Array.isArray(value)) return { success: false, error: { message: "Expected an array" } };
      const items: T[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const parsed = itemSchema.safeParse(value[index]);
        if (!parsed.success) return { success: false, error: { message: `Invalid array item at index ${index}: ${parsed.error.message}` } };
        items.push(parsed.data);
      }
      return { success: true, data: items };
    },
  };
}

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiClientError extends Error {
  constructor(message: string, readonly path: string, readonly cause?: unknown) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function requestJson<T>(options: {
  apiBase: string;
  path: string;
  schema: JsonSchema<T>;
  init?: RequestInit;
  headers?: HeadersInit;
  fetchFn?: ApiFetch;
}): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${options.apiBase}${options.path}`, { ...options.init, headers: { ...options.headers, ...options.init?.headers } });
  if (!response.ok) throw new ApiClientError(`${response.status}: ${await response.text()}`, options.path);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ApiClientError(`Invalid JSON response from ${options.path}`, options.path, error);
  }
  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    const details = typeof parsed.error.flatten === "function" ? JSON.stringify(parsed.error.flatten()) : parsed.error.message;
    throw new ApiClientError(`Invalid response from ${options.path}: ${details}`, options.path, parsed.error);
  }
  return parsed.data;
}
