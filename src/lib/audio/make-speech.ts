// "Make speech" (AQU-2577): one recipe that takes a line from source text to a
// take in a character's voice.
//
//   1. translate   the line has no target text yet — draft it
//   2. speak       a reader voice says the text (a voice that speaks the
//                  language well: pronunciation and pacing come from here)
//   3. re-voice    the reader's take is changed into the character's voice
//
// The steps already exist one at a time across the editor. The recipe is the
// order they run in and the two voices they run with, so the same thing can be
// done for one line, a selection or a file without visiting three places.
//
// The runner is pure: it is handed the three actions, so the order, the
// skipping and the stop-on-failure are tested here without an engine.

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"
import type { LineDelivery } from "@/lib/parsers/types"

export interface MakeSpeechRecipe {
  /** Draft the target text for a line that has none. */
  translate: boolean
  /** Stop once the text is drafted, so a person checks it before any speech is made. */
  reviewTranslation: boolean
  /** The voice that reads the text. Null: the line's own cast voice. */
  readerVoiceId: string | null
  /** The voice the reader's take is changed into. Null: no third step. */
  characterVoiceId: string | null
  /**
   * How the reader delivers these lines (speed, tags), set before a line has
   * any take. It belongs to the run, not the recipe: it is never remembered.
   */
  delivery?: LineDelivery
}

export const DEFAULT_MAKE_SPEECH_RECIPE: MakeSpeechRecipe = {
  translate: true,
  reviewTranslation: false,
  readerVoiceId: null,
  characterVoiceId: null,
}

export type MakeSpeechStep = "translate" | "speak" | "revoice"

export type MakeSpeechLineState =
  | { kind: "waiting" }
  | { kind: "running"; step: MakeSpeechStep }
  | { kind: "done" }
  /** Drafted and left for a person to check; no speech was made. */
  | { kind: "review" }
  /** No text and the recipe does not translate. */
  | { kind: "skipped" }
  | { kind: "failed"; step: MakeSpeechStep }

export interface MakeSpeechActions {
  /** Whether the line has target text right now (read again after a translate). */
  hasText(cellId: string): boolean
  translate(cellId: string): Promise<boolean>
  speak(cellId: string, readerVoiceId: string | null, delivery?: LineDelivery): Promise<boolean>
  revoice(cellId: string, characterVoiceId: string): Promise<boolean>
}

/** The steps the recipe runs for one line, given whether it has text yet. */
export function stepsForLine(recipe: MakeSpeechRecipe, hasText: boolean): MakeSpeechStep[] {
  if (!hasText && !recipe.translate) return []
  const steps: MakeSpeechStep[] = hasText ? [] : ["translate"]
  if (!hasText && recipe.reviewTranslation) return steps
  steps.push("speak")
  if (recipe.characterVoiceId && recipe.characterVoiceId !== recipe.readerVoiceId) steps.push("revoice")
  return steps
}

/**
 * Run the recipe over `cellIds`, one line at a time, in order. A line that
 * fails a step stops there and the run moves on: one bad line does not cost
 * the rest. Returns each line's final state.
 */
export async function runMakeSpeech(
  cellIds: readonly string[],
  recipe: MakeSpeechRecipe,
  actions: MakeSpeechActions,
  onProgress: (cellId: string, state: MakeSpeechLineState) => void,
  signal?: AbortSignal,
): Promise<Map<string, MakeSpeechLineState>> {
  const result = new Map<string, MakeSpeechLineState>()
  const set = (cellId: string, state: MakeSpeechLineState) => {
    result.set(cellId, state)
    onProgress(cellId, state)
  }
  for (const cellId of cellIds) set(cellId, { kind: "waiting" })
  for (const cellId of cellIds) {
    if (signal?.aborted) break
    const steps = stepsForLine(recipe, actions.hasText(cellId))
    if (steps.length === 0) {
      set(cellId, { kind: "skipped" })
      continue
    }
    let failed: MakeSpeechStep | null = null
    for (const step of steps) {
      set(cellId, { kind: "running", step })
      const ok = step === "translate"
        ? await actions.translate(cellId)
        : step === "speak"
          ? await actions.speak(cellId, recipe.readerVoiceId, recipe.delivery)
          : await actions.revoice(cellId, recipe.characterVoiceId ?? "")
      if (!ok) {
        failed = step
        break
      }
    }
    if (failed) set(cellId, { kind: "failed", step: failed })
    else set(cellId, steps.at(-1) === "translate" ? { kind: "review" } : { kind: "done" })
  }
  return result
}

// ── The recipe is remembered per project, on this device ────────────────────

const PREFIX = "aquilla:make-speech:"

export function loadMakeSpeechRecipe(projectId: string): MakeSpeechRecipe {
  try {
    const raw = localStorage.getItem(ownerScopedLocalStorageKey(PREFIX + projectId))
    if (!raw) return DEFAULT_MAKE_SPEECH_RECIPE
    const parsed = JSON.parse(raw) as Partial<MakeSpeechRecipe>
    return {
      translate: parsed.translate !== false,
      reviewTranslation: parsed.reviewTranslation === true,
      readerVoiceId: typeof parsed.readerVoiceId === "string" ? parsed.readerVoiceId : null,
      characterVoiceId: typeof parsed.characterVoiceId === "string" ? parsed.characterVoiceId : null,
    }
  } catch {
    return DEFAULT_MAKE_SPEECH_RECIPE
  }
}

export function saveMakeSpeechRecipe(projectId: string, recipe: MakeSpeechRecipe): void {
  try {
    localStorage.setItem(ownerScopedLocalStorageKey(PREFIX + projectId), JSON.stringify(recipe))
  } catch { /* quota / access denied — the recipe just isn't remembered */ }
}
