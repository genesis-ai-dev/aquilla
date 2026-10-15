import { createHash } from "node:crypto"

/** SHA-256 hex digest of a string or bytes. */
export const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex")

/** Short, readable digest for ids and revisions (first 16 hex chars = 64 bits). */
export const shortHash = (input: string | Uint8Array): string => sha256(input).slice(0, 16)

/**
 * JSON with sorted object keys, so equal values always hash equally regardless
 * of construction order. Undefined members are dropped, as in JSON.stringify.
 */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

export const hashValue = (value: unknown): string => shortHash(stableStringify(value))
