/** JSON calls to /api/host/*. The session cookie rides along; errors become messages. */

export async function api<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}
