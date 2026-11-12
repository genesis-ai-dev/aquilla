// Pure helpers for the Instructions pane (AQU-2342).

import { TRANSLATION_INSTRUCTIONS_MAX_CHARS } from "@/lib/instructions/project-instructions"

/** Idle time after the last keystroke before the instructions are saved. */
export const INSTRUCTIONS_SAVE_DEBOUNCE_MS = 800

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * The instructions after adding `addition` (the brief interview's summary):
 * unchanged when the addition is blank or already contained, the addition
 * alone when there is no text yet, else appended after a blank line. Capped at
 * the stored maximum.
 */
export function mergeIntoInstructions(current: string, addition: string): string {
  const add = addition.trim()
  if (!add) return current
  if (normalized(current).includes(normalized(add))) return current
  const base = current.trimEnd()
  const merged = base ? `${base}\n\n${add}` : add
  return merged.slice(0, TRANSLATION_INSTRUCTIONS_MAX_CHARS)
}
