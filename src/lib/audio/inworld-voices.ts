// Inworld stock-voice catalog for the New Voice picker (AQU-1189).
//
// Live voices come from sync-worker GET /api/v1/voice/tts/voices, filtered to
// SYSTEM voices whose primary language matches the project's target-language
// lanes. When no lookup can be attempted at all (no project/file context, no
// file-scoped sync token) we fall back to the small built-in English list.
//
// A lookup that WAS attempted and came back empty or failed reports
// `unavailable` with no voices (AQU-2035): an English list is the wrong set of
// choices for, say, Danish, so callers disable the picker instead of swapping
// the built-in list in behind the user's back. An unconfigured worker belongs
// here, not above: `listInworldVoices` throws on its 503, so every language
// reports `unavailable` and the picker is disabled rather than offering stock
// voices that could not be synthesized anyway.

import { useEffect, useState } from "react"
import { INWORLD_TTS_VOICES } from "./tts-providers"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { listInworldSupportedLanguages, listInworldVoices, type InworldCatalogVoice } from "@/lib/sync/tts"
import {
  fallbackDesignLanguages,
  type InworldSupportedLanguage,
} from "./inworld-supported-languages"
import type { FrontierSession } from "@/lib/frontier/types"
import { isLaneArchived } from "@/components/project-lane-archive"

export type { InworldCatalogVoice }

export function fallbackInworldCatalog(): InworldCatalogVoice[] {
  return INWORLD_TTS_VOICES.map((v) => ({
    voiceId: v.name,
    displayName: v.name,
    language: "en-US",
  }))
}

/**
 * Default target language + extra active lanes, in display order.
 *
 * Archived EXTRA lanes are omitted. This reads the legacy
 * `settings.archivedLanes` tag list, which cannot name the former default lane
 * (its tag is the empty string), so since AQU-1600 made that lane archivable
 * its language is still offered here even when the lane is archived. Fixing
 * that means reading the lane ROWS, which is the per-lane audio work
 * (AQU-1591 / AQU-1615), not this helper.
 */
export function projectTargetLaneLanguages(project: {
  targetLanguage?: string
  targetLanes?: readonly string[]
  archivedLanes?: readonly string[]
}): string[] {
  const archived = project.archivedLanes ?? []
  const out: string[] = []
  const add = (raw: string | undefined) => {
    const value = raw?.trim()
    if (!value) return
    if (isLaneArchived(value, archived)) return
    if (out.some((existing) => existing.toLowerCase() === value.toLowerCase())) return
    out.push(value)
  }
  add(project.targetLanguage)
  for (const lane of project.targetLanes ?? []) add(lane)
  return out
}

export function showVoiceLanguageBadge(languages: readonly string[]): boolean {
  return languages.length > 1
}

/**
 * `fallback` — no lookup was attempted, so the built-in English list stands in.
 * `unavailable` — a lookup ran and came back empty or failed; there are no
 * voices to offer for the chosen language (AQU-2035).
 */
export type InworldCatalogStatus = "loading" | "ready" | "fallback" | "unavailable"

const catalogCache = new Map<string, InworldCatalogVoice[]>()

/** @internal — test seam. */
export function __resetInworldCatalogCacheForTests(): void {
  catalogCache.clear()
}

function cacheKey(projectId: string, languages: readonly string[]): string {
  return `${projectId}::${[...languages].map((l) => l.trim().toLowerCase()).sort().join(",")}`
}

export function useInworldCatalogVoices(args: {
  enabled: boolean
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  languages: readonly string[]
  /** Every SYSTEM voice, not filtered to project lanes — Voice Design locales. */
  allSystem?: boolean
}): { voices: InworldCatalogVoice[]; status: InworldCatalogStatus } {
  const { enabled, projectId, fileId, session, languages, allSystem = false } = args
  const langKey = allSystem ? "all" : languages.map((l) => l.trim().toLowerCase()).join(",")
  const [voices, setVoices] = useState<InworldCatalogVoice[]>(fallbackInworldCatalog)
  const [status, setStatus] = useState<InworldCatalogStatus>("fallback")

  useEffect(() => {
    if (!enabled) return
    if (!projectId || !fileId || !session?.jwt || (!allSystem && languages.length === 0)) {
      setVoices(fallbackInworldCatalog())
      setStatus("fallback")
      return
    }
    const key = cacheKey(projectId, allSystem ? ["*"] : languages)
    const cached = catalogCache.get(key)
    if (cached) {
      setVoices(cached)
      setStatus("ready")
      return
    }
    let cancelled = false
    setStatus("loading")
    const langs = [...languages]
    const sessionRef = session
    void listInworldVoices(
      { projectId, fileId, languages: langs, all: allSystem },
      audioSyncTokenFetcherForSession(sessionRef),
    ).then((rows) => {
      if (cancelled) return
      if (rows.length === 0) {
        setVoices([])
        setStatus("unavailable")
        return
      }
      catalogCache.set(key, rows)
      setVoices(rows)
      setStatus("ready")
    }).catch(() => {
      if (cancelled) return
      setVoices([])
      setStatus("unavailable")
    })
    return () => { cancelled = true }
    // langKey / jwt stand in for languages and session identity.
  }, [enabled, projectId, fileId, session?.jwt, langKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { voices, status }
}

const supportedLanguageCache = new Map<string, InworldSupportedLanguage[]>()

/** @internal — test seam. */
export function __resetInworldSupportedLanguagesCacheForTests(): void {
  supportedLanguageCache.clear()
}

export function useInworldSupportedLanguages(args: {
  enabled: boolean
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
}): { languages: InworldSupportedLanguage[]; status: "loading" | "ready" | "fallback" } {
  const { enabled, projectId, fileId, session } = args
  const [languages, setLanguages] = useState<InworldSupportedLanguage[]>(fallbackDesignLanguages)
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("fallback")

  useEffect(() => {
    if (!enabled || !projectId || !fileId || !session?.jwt) {
      setLanguages(fallbackDesignLanguages())
      setStatus("fallback")
      return
    }
    const cached = supportedLanguageCache.get(projectId)
    if (cached) {
      setLanguages(cached)
      setStatus("ready")
      return
    }
    let cancelled = false
    setStatus("loading")
    const sessionRef = session
    void listInworldSupportedLanguages(
      { projectId, fileId },
      audioSyncTokenFetcherForSession(sessionRef),
    ).then((rows) => {
      if (cancelled) return
      if (rows.length === 0) {
        setLanguages(fallbackDesignLanguages())
        setStatus("fallback")
        return
      }
      supportedLanguageCache.set(projectId, rows)
      setLanguages(rows)
      setStatus("ready")
    }).catch(() => {
      if (cancelled) return
      setLanguages(fallbackDesignLanguages())
      setStatus("fallback")
    })
    return () => { cancelled = true }
  }, [enabled, projectId, fileId, session?.jwt])

  return { languages, status }
}
