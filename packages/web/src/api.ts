export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // Only declare a JSON body when there is one: Fastify rejects a body-less
    // POST that claims Content-Type: application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : { ...init?.headers },
  });
  if (!response.ok) throw new ApiError(response.status, await describe(response));
  return response.json() as Promise<T>;
}

/**
 * What went wrong, in terms someone can act on.
 *
 * Every error this server sends carries an `error` field, so a failure without
 * one did not come from the server: it came from whatever sits in front of it.
 * "502: unknown" sent someone hunting through application logs for a fault that
 * was a proxy reporting the backend had stopped answering.
 */
async function describe(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON — an intermediary answered instead of the app */
  }
  if (response.status === 502 || response.status === 504) {
    return "伺服器沒有回應(可能重啟中或處理逾時)— 這是反向代理回報的,不是應用程式";
  }
  if (response.status === 413) return "傳送的內容太大";
  return text.trim().slice(0, 120) || `HTTP ${response.status}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`);
  }
}
