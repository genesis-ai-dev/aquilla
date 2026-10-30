/**
 * person-prefs-api.ts — the calls that read and write a person's preferences
 * on the server (`users.preferences`, AQU-2264).
 *
 * Writes go to `PATCH /api/v2/auth/me/preferences`, which MERGES only the keys
 * sent. Never send the whole record to `PATCH /api/v2/auth/me`: that replaces
 * it, and a write from another device or another feature made since the read
 * would be undone.
 *
 * Reads go to `GET /api/v2/auth/me/preferences`, which reads the row itself;
 * `GET /api/v2/auth/me` answers from a session cache that can be 30 s behind.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

export type PersonPreferences = Record<string, unknown>

export interface PersonPreferencesPatch {
  /** Written over whatever is stored. */
  set?: PersonPreferences
  /** Written only for keys the person has none of yet. */
  setIfAbsent?: PersonPreferences
}

const URL_PATH = "/api/v2/auth/me/preferences"

function asRecord(value: unknown): PersonPreferences {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PersonPreferences) : {}
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "")
  return Object.assign(new Error(`preferences ${what} failed: HTTP ${res.status} — ${body.slice(0, 200)}`), {
    status: res.status,
  })
}

/** The person's whole record (`{}` when they have none). Throws on failure. */
export async function fetchPersonPreferences(jwt: string, signal?: AbortSignal): Promise<PersonPreferences> {
  const res = await fetchWithTimeout(`${AUTH_BASE}${URL_PATH}`, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal,
  })
  if (!res.ok) throw await failure(res, "fetch")
  return asRecord(((await res.json()) as { preferences?: unknown }).preferences)
}

/**
 * Merge `patch` into the person's record; resolves to the record as stored
 * after the write. Throws on failure (offline, refused, timed out).
 */
export async function patchPersonPreferences(
  jwt: string,
  patch: PersonPreferencesPatch,
): Promise<PersonPreferences> {
  const res = await fetchWithTimeout(`${AUTH_BASE}${URL_PATH}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await failure(res, "save")
  return asRecord(((await res.json()) as { preferences?: unknown }).preferences)
}
