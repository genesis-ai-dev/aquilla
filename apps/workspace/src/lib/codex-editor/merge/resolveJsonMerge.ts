// src/lib/codex-editor/merge/resolveJsonMerge.ts
// Two-way deep merge for arbitrary JSON files. Lossy only when both sides set
// the same scalar key to different values — logs a warning and takes theirs.

type JsonVal = unknown

function isObj(v: JsonVal): v is Record<string, JsonVal> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function dedupeArray(arr: JsonVal[]): JsonVal[] {
  const seen = new Set<string>()
  const out: JsonVal[] = []
  for (const v of arr) {
    const k = JSON.stringify(v)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function deepMerge(a: JsonVal, b: JsonVal, path = ""): JsonVal {
  if (a === undefined) return b
  if (b === undefined) return a
  if (isObj(a) && isObj(b)) {
    const out: Record<string, JsonVal> = { ...a }
    for (const k of Object.keys(b)) {
      out[k] = deepMerge(a[k], b[k], path ? `${path}.${k}` : k)
    }
    return out
  }
  if (Array.isArray(a) && Array.isArray(b)) return dedupeArray([...a, ...b])
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.warn(`[json-merge] scalar conflict at "${path}" — taking theirs`)
  }
  return b
}

export async function resolveJsonMergeTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes
  const ours = JSON.parse(ourBytes)
  const theirs = JSON.parse(theirBytes)
  return JSON.stringify(deepMerge(ours, theirs), null, 2)
}
