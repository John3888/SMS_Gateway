export class SessionExpired extends Error {}

export async function adminGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/admin/" + path, { cache: "no-store", signal });
  if (response.status === 401) throw new SessionExpired("Please sign in.");
  if (!response.ok) throw new Error("Gateway unavailable (" + response.status + ").");
  return response.json();
}
