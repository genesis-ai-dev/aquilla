/**
 * repetition-choice-pref — the remembered answer to "Validate all repeated
 * rows, or just this one?" (AQU-1486).
 *
 * The dialog's "Don't ask again" stores the reviewer's answer per user, per
 * project: one project may want every repeat signed off at once while another
 * wants each one read. Absent means "ask". The toast shown when a remembered
 * answer is applied carries "Ask me each time", which clears it.
 *
 * Key schema: `aq.repetition-choice.v1` → `{ "<username>\u0000<projectId>": "all" | "one" }`.
 */

import type { RepetitionChoice } from "@/lib/workflow/repetition-validation"

const STORAGE_KEY = "aq.repetition-choice.v1"

type ChoiceMap = Record<string, RepetitionChoice>

function entryKey(username: string, projectId: string): string {
  return `${username}\u0000${projectId}`
}

function readMap(): ChoiceMap {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: ChoiceMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "all" || value === "one") out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(map: ChoiceMap): void {
  if (typeof localStorage === "undefined") return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / access denied — the dialog simply asks again next time
  }
}

/** The remembered answer for this user on this project, or null to ask. */
export function getRepetitionChoice(username: string, projectId: string): RepetitionChoice | null {
  return readMap()[entryKey(username, projectId)] ?? null
}

/** Remember an answer, or pass null to go back to asking. */
export function setRepetitionChoice(
  username: string,
  projectId: string,
  choice: RepetitionChoice | null,
): void {
  const map = readMap()
  const key = entryKey(username, projectId)
  if (choice === null) delete map[key]
  else map[key] = choice
  writeMap(map)
}
