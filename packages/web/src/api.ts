export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // Only declare a JSON body when there is one: Fastify rejects a body-less
    // POST that claims Content-Type: application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : { ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, (body as { error?: string }).error ?? "unknown");
  }
  return response.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`);
  }
}
