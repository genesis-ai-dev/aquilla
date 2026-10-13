/**
 * bible-data-view-prefs — each person's view options for Bible data (AQU-1687):
 * voice chips on/off, speech rails on/off, and the label language. AQU-1689
 * adds Who's Who: when mention highlights show (on hover, always, or never)
 * and how many implied-subject hints the source text shows.
 *
 * Device-local, like the "Show cell labels" switch: what a person likes to see
 * while they read, not a project fact. Whether Voices exists at all is the
 * project's `bibleEnrichments` setting; these only hide what it shows.
 *
 * Stored as one JSON object. A missing or unreadable value, or one field of
 * the wrong type, reads as that field's default, so a stored value can never
 * switch on something the person did not choose.
 *
 * Key schema: `aq.bible-data-view.v1` →
 *   { voiceChips?: boolean, speechRails?: boolean, labelMode?: VoiceLabelMode,
 *     whosWhoHighlights?: WhosWhoHighlightMode,
 *     impliedSubjectHints?: ImpliedSubjectHintMode }
 */

import { useSyncExternalStore } from "react"
import { DEFAULT_VOICE_LABEL_MODE, isVoiceLabelMode, type VoiceLabelMode } from "@/lib/bible-data/voice-labels"

const STORAGE_KEY = "aq.bible-data-view.v1"

/**
 * When Who's Who marks the people a source word refers to:
 *   hover  — a light underline at rest; hovering or focusing a mention tints
 *            every mention of that participant in view;
 *   always — every mention carries its participant's tint;
 *   off    — no marks in the source text (the panel and the Context tab stay).
 */
export const WHOS_WHO_HIGHLIGHT_MODES = ["hover", "always", "off"] as const
export type WhosWhoHighlightMode = (typeof WHOS_WHO_HIGHLIGHT_MODES)[number]

/**
 * Which implied subjects get a hint before their verb ("[he = Jesus]"):
 * none, only those the data names (an ACAI person, deity or group), or all.
 */
export const IMPLIED_SUBJECT_HINT_MODES = ["off", "names", "all"] as const
export type ImpliedSubjectHintMode = (typeof IMPLIED_SUBJECT_HINT_MODES)[number]

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
}

export function isWhosWhoHighlightMode(value: unknown): value is WhosWhoHighlightMode {
  return isOneOf(WHOS_WHO_HIGHLIGHT_MODES, value)
}

export function isImpliedSubjectHintMode(value: unknown): value is ImpliedSubjectHintMode {
  return isOneOf(IMPLIED_SUBJECT_HINT_MODES, value)
}

export interface BibleDataViewPrefs {
  voiceChips: boolean
  speechRails: boolean
  labelMode: VoiceLabelMode
  whosWhoHighlights: WhosWhoHighlightMode
  impliedSubjectHints: ImpliedSubjectHintMode
}

export const DEFAULT_BIBLE_DATA_VIEW_PREFS: BibleDataViewPrefs = Object.freeze({
  voiceChips: true,
  speechRails: true,
  labelMode: DEFAULT_VOICE_LABEL_MODE,
  whosWhoHighlights: "hover",
  impliedSubjectHints: "names",
})

const listeners = new Set<() => void>()

/** Cached snapshot, so useSyncExternalStore sees one object between writes. */
let cached: BibleDataViewPrefs | undefined

function read(): BibleDataViewPrefs {
  if (typeof localStorage === "undefined") return DEFAULT_BIBLE_DATA_VIEW_PREFS
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
  } catch {
    return DEFAULT_BIBLE_DATA_VIEW_PREFS
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return DEFAULT_BIBLE_DATA_VIEW_PREFS
  const value = stored as Record<string, unknown>
  return {
    voiceChips: typeof value.voiceChips === "boolean" ? value.voiceChips : DEFAULT_BIBLE_DATA_VIEW_PREFS.voiceChips,
    speechRails: typeof value.speechRails === "boolean" ? value.speechRails : DEFAULT_BIBLE_DATA_VIEW_PREFS.speechRails,
    labelMode: isVoiceLabelMode(value.labelMode) ? value.labelMode : DEFAULT_BIBLE_DATA_VIEW_PREFS.labelMode,
    whosWhoHighlights: isWhosWhoHighlightMode(value.whosWhoHighlights)
      ? value.whosWhoHighlights
      : DEFAULT_BIBLE_DATA_VIEW_PREFS.whosWhoHighlights,
    impliedSubjectHints: isImpliedSubjectHintMode(value.impliedSubjectHints)
      ? value.impliedSubjectHints
      : DEFAULT_BIBLE_DATA_VIEW_PREFS.impliedSubjectHints,
  }
}

function peek(): BibleDataViewPrefs {
  if (cached === undefined) cached = read()
  return cached
}

export function getBibleDataViewPrefs(): BibleDataViewPrefs {
  return peek()
}

export function setBibleDataViewPrefs(patch: Partial<BibleDataViewPrefs>): void {
  const next = { ...peek(), ...patch }
  cached = next
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota / access denied — the in-memory value still reflects the change
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the Bible data view options. */
export function useBibleDataViewPrefs(): BibleDataViewPrefs {
  return useSyncExternalStore(subscribe, peek, () => DEFAULT_BIBLE_DATA_VIEW_PREFS)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetBibleDataViewPrefsCacheForTests(): void {
  cached = undefined
}
