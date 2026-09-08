// Inworld stock-voice catalog for the New Voice picker (AQU-1189).
//
// Live voices come from sync-worker GET /api/v1/voice/tts/voices, filtered to
// SYSTEM voices whose primary language matches the project's target-language
// lanes. When the worker isn't configured (no API key) or the editor has no
// file-scoped sync token, we fall back to the small built-in English list.

import { useEffect, useState } from "react"
import { INWORLD_TTS_VOICES } from "./tts-providers"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { listInworldSupportedLanguages, listInworldVoices, type InworldCatalogVoice } from "@/lib/sync/tts"
import {
  fallbackDesignLanguages,
  type InworldSupportedLanguage,
} from "./inworld-supported-languages"
import type { FrontierSession } from "@/lib/frontier/types"

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
 * Archived extra lanes are omitted (the default lane cannot be archived).
 */
export function projectTargetLaneLanguages(project: {
  targetLanguage?: string
  targetLanes?: readonly string[]
  archivedLanes?: readonly string[]
}): string[] {
  const archived = new Set(
    (project.archivedLanes ?? [])
      .map((lane) => lane.trim().toLowerCase())
      .filter(Boolean),
  )
  const out: string[] = []
  const add = (raw: string | undefined) => {
    const value = raw?.trim()
    if (!value) return
    const key = value.toLowerCase()
    if (archived.has(key)) return
    if (out.some((existing) => existing.toLowerCase() === key)) return
    out.push(value)
  }
  add(project.targetLanguage)
  for (const lane of project.targetLanes ?? []) add(lane)
  return out
}

export function showVoiceLanguageBadge(languages: readonly string[]): boolean {
  return languages.length > 1
}

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
}): { voices: InworldCatalogVoice[]; status: "loading" | "ready" | "fallback"; attempted: boolean } {
  const { enabled, projectId, fileId, session, languages, allSystem = false } = args
  const langKey = allSystem ? "all" : languages.map((l) => l.trim().toLowerCase()).join(",")
  const canFetch = Boolean(
    enabled && projectId && fileId && session?.jwt && (allSystem || languages.length > 0),
  )
  const [voices, setVoices] = useState<InworldCatalogVoice[]>(fallbackInworldCatalog)
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("fallback")

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
        setVoices(fallbackInworldCatalog())
        setStatus("fallback")
        return
      }
      catalogCache.set(key, rows)
      setVoices(rows)
      setStatus("ready")
    }).catch(() => {
      if (cancelled) return
      setVoices(fallbackInworldCatalog())
      setStatus("fallback")
    })
    return () => { cancelled = true }
    // langKey / jwt stand in for languages and session identity.
  }, [enabled, projectId, fileId, session?.jwt, langKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { voices, status, attempted: canFetch }
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
