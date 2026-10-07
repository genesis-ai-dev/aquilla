// AQU-463: per-project memory of the transcript corrections a human has made,
// persisted in localStorage keyed by projectId.
//
// Why localStorage and not the project record: same reason as
// project-tts-store.ts — under the AD-3 thin client the project record is
// server-sourced and re-hydrated on load, so settings written only there are
// silently dropped. These rules are client-owned learning state that must
// survive a reload to be worth anything.
//
// Scope is deliberately per PROJECT: an ASR error is a property of one
// language and one recording setup. Carrying a Kilisusu correction into an
// unrelated project's transcripts would be a regression, not a feature.

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"
import {
  learnCorrections,
  extractCorrections,
  applyCorrections,
  type CorrectionRule,
} from "@/lib/audio/transcript-corrections"

const PREFIX = "frontier:transcript-corrections:"

function storageKey(projectId: string): string {
  return ownerScopedLocalStorageKey(PREFIX + projectId)
}

/** A rule that survived JSON round-tripping intact. Anything else is dropped. */
function isRule(value: unknown): value is CorrectionRule {
  if (!value || typeof value !== "object") return false
  const r = value as Partial<CorrectionRule>
  return (
    typeof r.heard === "string" &&
    r.heard.length > 0 &&
    typeof r.corrected === "string" &&
    r.corrected.length > 0 &&
    typeof r.count === "number" &&
    typeof r.updatedAt === "number"
  )
}

export function loadTranscriptCorrections(projectId: string): CorrectionRule[] {
  try {
    if (typeof localStorage === "undefined") return []
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRule)
  } catch {
    return []
  }
}

export function saveTranscriptCorrections(projectId: string, rules: readonly CorrectionRule[]): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(storageKey(projectId), JSON.stringify(rules))
  } catch {
    /* quota / access denied — ignore; the transcript edit itself still lands */
  }
}

export function clearTranscriptCorrections(projectId: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(storageKey(projectId))
  } catch {
    /* access denied — nothing to do */
  }
}

/**
 * The learning half of the loop: a human corrected `original` to `corrected`
 * in this project, so keep whatever transferable pairs that edit contains.
 * Returns the pairs learned (empty when the edit taught us nothing).
 *
 * Best-effort by design — a failure to learn must never cost the user their
 * correction, which is committed by the caller independently of this.
 */
export function learnFromTranscriptCorrection(
  projectId: string,
  original: string,
  corrected: string,
): Array<{ heard: string; corrected: string }> {
  const pairs = extractCorrections(original, corrected)
  if (pairs.length === 0) return []
  saveTranscriptCorrections(projectId, learnCorrections(loadTranscriptCorrections(projectId), pairs))
  return pairs
}

/**
 * The applying half: replay this project's learned corrections over a fresh
 * ASR transcript. Token-for-token, so word timings stay valid.
 */
export function applyLearnedCorrections(projectId: string, text: string): string {
  if (!text) return text
  return applyCorrections(text, loadTranscriptCorrections(projectId))
}
