// AQU-463 — the persisted half of the correction-learning loop. The property
// worth pinning is the SCOPE: what a translator teaches one project must not
// leak into another, and corrupt stored state must never break transcription.

import { describe, it, expect, beforeEach } from "vitest"
import {
  loadTranscriptCorrections,
  saveTranscriptCorrections,
  clearTranscriptCorrections,
  learnFromTranscriptCorrection,
  applyLearnedCorrections,
} from "./transcript-corrections-store"

describe("transcript-corrections-store", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips learned rules for a project", () => {
    learnFromTranscriptCorrection("p1", "the killy elders met", "the kilisusu elders met")
    expect(loadTranscriptCorrections("p1")).toMatchObject([{ heard: "killy", corrected: "kilisusu", count: 1 }])
  })

  it("applies what one project learned to that project's later transcripts", () => {
    learnFromTranscriptCorrection("p1", "the killy elders met", "the kilisusu elders met")
    expect(applyLearnedCorrections("p1", "Killy elders spoke.")).toBe("Kilisusu elders spoke.")
  })

  it("keeps one project's corrections out of another's", () => {
    learnFromTranscriptCorrection("p1", "the killy elders met", "the kilisusu elders met")
    expect(applyLearnedCorrections("p2", "Killy elders spoke.")).toBe("Killy elders spoke.")
  })

  it("reports what it learned, and learns nothing from a rewrite", () => {
    expect(learnFromTranscriptCorrection("p1", "one two three four", "alpha bravo charlie four")).toEqual([])
    expect(loadTranscriptCorrections("p1")).toEqual([])
  })

  it("survives corrupt or foreign stored state", () => {
    saveTranscriptCorrections("p1", [{ heard: "killy", corrected: "kilisusu", count: 1, updatedAt: 1 }])
    const key = Object.keys(localStorage).find((k) => k.includes("transcript-corrections:p1"))
    expect(key).toBeDefined()

    localStorage.setItem(key as string, "{not json")
    expect(loadTranscriptCorrections("p1")).toEqual([])
    expect(applyLearnedCorrections("p1", "Killy sang.")).toBe("Killy sang.")

    // A well-formed array whose entries are the wrong shape drops the entries,
    // not the read — a half-written rule must not take transcription with it.
    localStorage.setItem(key as string, JSON.stringify([{ heard: "killy" }, null, 7]))
    expect(loadTranscriptCorrections("p1")).toEqual([])
  })

  it("clears a project's learned corrections", () => {
    learnFromTranscriptCorrection("p1", "the killy elders met", "the kilisusu elders met")
    clearTranscriptCorrections("p1")
    expect(loadTranscriptCorrections("p1")).toEqual([])
  })

  it("leaves empty text untouched", () => {
    learnFromTranscriptCorrection("p1", "the killy elders met", "the kilisusu elders met")
    expect(applyLearnedCorrections("p1", "")).toBe("")
  })
})
