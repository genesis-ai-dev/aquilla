// "Make speech" (AQU-2577): one recipe that takes a line from source text to a
// take in a character's voice.
//
//   1. translate   the line has no target text yet: draft it. Always runs; a
//                  person then checks the drafts before any speech is made
//                  (speech costs more than a draft).
//   2. speak       the chosen voice says the text (pronunciation and pacing
//                  come from here)
//   3. clone       optional: the take is re-voiced into a character's voice
//
// The steps already exist one at a time across the editor. The recipe is the
// order they run in and the voices they run with, so the same thing can be
// done for one line or many without visiting three places.
//
// The runner is pure: it is handed the actions, so the order, the skipping and
// the stop-on-failure are tested here without an engine.

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"
import type { LineDelivery } from "@/lib/parsers/types"

export interface MakeSpeechRecipe {
  /** The voice that reads the text. Null: the line's own cast voice. */
  readerVoiceId: string | null
  /** Clone the reader's take into `characterVoiceId`. */
  clone: boolean
  /** The voice the take is cloned into. */
  characterVoiceId: string | null
  /**
   * How the reader delivers these lines (speed, tags), set before a line has
   * any take. It belongs to the run, not the recipe: it is never remembered.
   */
  delivery?: LineDelivery
}

export const DEFAULT_MAKE_SPEECH_RECIPE: MakeSpeechRecipe = {
  readerVoiceId: null,
  clone: false,
  characterVoiceId: null,
}

export type MakeSpeechStep = "translate" | "speak" | "revoice"

export type MakeSpeechLineState =
  | { kind: "waiting" }
  | { kind: "running"; step: MakeSpeechStep }
  | { kind: "done" }
  /** Drafted and waiting for a person to check it; no speech was made. */
  | { kind: "review" }
  /** No text to speak. */
  | { kind: "skipped" }
  /** `reason` is what the step said went wrong, when it said anything. */
  | { kind: "failed"; step: MakeSpeechStep; reason?: string }

export interface MakeSpeechActions {
  /** Whether the line has target text right now (read again after a translate). */
  hasText(cellId: string): boolean
  translate(cellId: string): Promise<boolean>
  speak(cellId: string, readerVoiceId: string | null, delivery?: LineDelivery): Promise<boolean>
  revoice(cellId: string, characterVoiceId: string): Promise<boolean>
  /** Why a step that resolved false failed, when the engine wrote it down. */
  failureReason?(cellId: string, step: MakeSpeechStep): string | undefined
}

/** Whether the recipe clones, and into a voice other than the reader. */
export function recipeClones(recipe: MakeSpeechRecipe): boolean {
  return recipe.clone && recipe.characterVoiceId != null && recipe.characterVoiceId !== recipe.readerVoiceId
}

/** The speech steps the recipe runs for a line that has its text. */
export function stepsForLine(recipe: MakeSpeechRecipe, hasText: boolean): MakeSpeechStep[] {
  if (!hasText) return []
  return recipeClones(recipe) ? ["speak", "revoice"] : ["speak"]
}

async function runStep(
  cellId: string,
  step: MakeSpeechStep,
  run: () => Promise<boolean>,
  actions: MakeSpeechActions,
): Promise<MakeSpeechLineState | null> {
  try {
    if (await run()) return null
    const reason = actions.failureReason?.(cellId, step)
    return { kind: "failed", step, ...(reason ? { reason } : {}) }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { kind: "failed", step, ...(reason ? { reason } : {}) }
  }
}

type Progress = (cellId: string, state: MakeSpeechLineState) => void

/**
 * Step 1: draft every line in `cellIds` that has no text. A drafted line is
 * left in `review`, for a person to check before speech is made. Returns the
 * lines that were drafted.
 */
export async function translateMissing(
  cellIds: readonly string[],
  actions: MakeSpeechActions,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<string[]> {
  const drafted: string[] = []
  const todo = cellIds.filter((id) => !actions.hasText(id))
  for (const cellId of todo) onProgress(cellId, { kind: "waiting" })
  for (const cellId of todo) {
    if (signal?.aborted) break
    onProgress(cellId, { kind: "running", step: "translate" })
    const failed = await runStep(cellId, "translate", () => actions.translate(cellId), actions)
    if (failed) {
      onProgress(cellId, failed)
      continue
    }
    drafted.push(cellId)
    onProgress(cellId, { kind: "review" })
  }
  return drafted
}

/**
 * Steps 2 and 3 over `cellIds`, one line at a time, in order. A line that
 * fails a step stops there and the run moves on: one bad line does not cost
 * the rest. A line with no text is skipped. Returns each line's final state.
 */
export async function runMakeSpeech(
  cellIds: readonly string[],
  recipe: MakeSpeechRecipe,
  actions: MakeSpeechActions,
  onProgress: Progress,
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
    let failed: MakeSpeechLineState | null = null
    for (const step of steps) {
      set(cellId, { kind: "running", step })
      failed = await runStep(cellId, step, () => step === "speak"
        ? actions.speak(cellId, recipe.readerVoiceId, recipe.delivery)
        : actions.revoice(cellId, recipe.characterVoiceId ?? ""), actions)
      if (failed) break
    }
    set(cellId, failed ?? { kind: "done" })
  }
  return result
}

/** Plain text as the editor's HTML: escaped, nothing else. */
export function plainTextHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ── The recipe is remembered per project, on this device ────────────────────

const PREFIX = "aquilla:make-speech:"

export function loadMakeSpeechRecipe(projectId: string): MakeSpeechRecipe {
  try {
    const raw = localStorage.getItem(ownerScopedLocalStorageKey(PREFIX + projectId))
    if (!raw) return DEFAULT_MAKE_SPEECH_RECIPE
    const parsed = JSON.parse(raw) as Partial<MakeSpeechRecipe>
    const characterVoiceId = typeof parsed.characterVoiceId === "string" ? parsed.characterVoiceId : null
    return {
      readerVoiceId: typeof parsed.readerVoiceId === "string" ? parsed.readerVoiceId : null,
      // A recipe saved before the toggle cloned whenever it named a character.
      clone: typeof parsed.clone === "boolean" ? parsed.clone : characterVoiceId != null,
      characterVoiceId,
    }
  } catch {
    return DEFAULT_MAKE_SPEECH_RECIPE
  }
}

export function saveMakeSpeechRecipe(projectId: string, recipe: MakeSpeechRecipe): void {
  try {
    const { delivery: _delivery, ...kept } = recipe
    localStorage.setItem(ownerScopedLocalStorageKey(PREFIX + projectId), JSON.stringify(kept))
  } catch { /* quota / access denied — the recipe just isn't remembered */ }
}
