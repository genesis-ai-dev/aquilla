// The connected ElevenLabs account's voices as a searchable grid (AQU-2299).
// Same visual language as CharacterVoicePicker: each card's avatar previews the
// voice (ElevenLabs' own preview_url), the card says what kind of voice it is
// (Premade / Cloned / Designed / Professional) and up to two of its labels.
// Clicking a card selects it; chips filter by kind.
import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Pause, Play, Search } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import { VOICE_PALETTE } from "@/lib/audio/voices"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  listElevenLabsVoices,
  type ElevenLabsVoiceCategory,
  type ElevenLabsVoiceRow,
} from "@/lib/sync/elevenlabs"
import type { FrontierSession } from "@/lib/frontier/types"
import { ELEVENLABS_CATEGORY_LABEL_KEYS, filterElevenLabsVoices, voiceLabelChips } from "./helpers"

const FILTERS: readonly ElevenLabsVoiceCategory[] = ["premade", "cloned", "generated", "professional"]

function accentFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return VOICE_PALETTE[h % VOICE_PALETTE.length] ?? VOICE_PALETTE[0]
}

export interface ElevenLabsVoiceBrowserProps {
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** The connected key; the list reloads when it changes. */
  apiKey: string
  selectedId?: string
  onSelect: (voice: ElevenLabsVoiceRow) => void
  /** Bump to re-fetch (e.g. after a clone). */
  reloadToken?: number
  /** A voice to show even before the account list catches up (a fresh clone). */
  pinned?: ElevenLabsVoiceRow | null
}

type Load =
  | { status: "loading" }
  | { status: "ready"; voices: ElevenLabsVoiceRow[]; nextPageToken: string | null }
  | { status: "error"; message: string }

export function ElevenLabsVoiceBrowser({
  projectId, fileId, session, apiKey, selectedId, onSelect, reloadToken = 0, pinned,
}: ElevenLabsVoiceBrowserProps) {
  const t = useT()
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<ElevenLabsVoiceCategory | null>(null)
  const [result, setResult] = useState<{ id: string; load: Load } | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [retry, setRetry] = useState(0)

  // Debounce typing into one request.
  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 250)
    return () => clearTimeout(id)
  }, [query])

  // The request this render wants; a result for any other one reads as loading.
  const requestId = `${apiKey}\u0000${search}\u0000${reloadToken}\u0000${retry}`
  useEffect(() => {
    if (!projectId || !session) return
    let live = true
    listElevenLabsVoices({ projectId, fileId, apiKey, search }, audioSyncTokenFetcherForSession(session))
      .then((page) => { if (live) setResult({ id: requestId, load: { status: "ready", ...page } }) })
      .catch((e: unknown) => {
        if (live) setResult({ id: requestId, load: { status: "error", message: categorizeAiError(e instanceof Error ? e.message : String(e)).body } })
      })
    return () => { live = false }
  }, [projectId, fileId, session, apiKey, search, requestId])
  const load: Load = result?.id === requestId ? result.load : { status: "loading" }

  const loadMore = async () => {
    if (load.status !== "ready" || !load.nextPageToken || !projectId || !session) return
    setMoreBusy(true)
    try {
      const page = await listElevenLabsVoices(
        { projectId, fileId, apiKey, search, pageToken: load.nextPageToken },
        audioSyncTokenFetcherForSession(session),
      )
      setResult({ id: requestId, load: { status: "ready", voices: [...load.voices, ...page.voices], nextPageToken: page.nextPageToken } })
    } catch (e) {
      setResult({ id: requestId, load: { status: "error", message: categorizeAiError(e instanceof Error ? e.message : String(e)).body } })
    } finally {
      setMoreBusy(false)
    }
  }

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const stop = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingId(null)
  }, [])
  useEffect(() => () => stop(), [stop])
  const togglePreview = useCallback((voice: ElevenLabsVoiceRow) => {
    if (playingId === voice.id || !voice.previewUrl) {
      stop()
      return
    }
    stop()
    const audio = new Audio(voice.previewUrl)
    audioRef.current = audio
    audio.onended = () => stop()
    setPlayingId(voice.id)
    audio.play().catch(() => stop())
  }, [playingId, stop])

  const fetched = load.status === "ready" ? load.voices : []
  const all = pinned && !fetched.some((v) => v.id === pinned.id) ? [pinned, ...fetched] : fetched
  const shown = filterElevenLabsVoices(all, category)

  return (
    <div className="space-y-2.5">
      <InputGroup className="h-9">
        <InputGroupAddon>
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("audio.elevenLabs.searchPlaceholder")}
          aria-label={t("audio.elevenLabs.searchAriaLabel")}
        />
      </InputGroup>

      <div className="flex flex-wrap gap-1" role="group" aria-label={t("audio.elevenLabs.filterGroupAriaLabel")}>
        {FILTERS.map((f) => (
          <Toggle
            key={f}
            size="sm"
            variant="outline"
            pressed={category === f}
            onPressedChange={() => setCategory((cur) => (cur === f ? null : f))}
            className="h-6 rounded-full px-2.5 text-[11px] text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
          >
            {t(ELEVENLABS_CATEGORY_LABEL_KEYS[f])}
          </Toggle>
        ))}
      </div>

      {load.status === "error" ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="min-w-0 text-xs text-destructive" role="alert">{load.message}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>{t("common.retry")}</Button>
        </div>
      ) : load.status === "loading" && all.length === 0 ? (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-busy="true" aria-label={t("audio.elevenLabs.loadingVoices")}>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-xl border p-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-32" />
              </div>
            </li>
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("audio.elevenLabs.noVoices")}</p>
      ) : (
        <ul className="grid max-h-[17rem] grid-cols-1 gap-1.5 overflow-y-auto pe-1 sm:grid-cols-2">
          {shown.map((v) => {
            const selected = v.id === selectedId
            const playing = playingId === v.id
            const accent = accentFor(v.id)
            const chips = voiceLabelChips(v.labels)
            return (
              <li
                key={v.id}
                className={cn(
                  "group/card relative flex items-center gap-2.5 rounded-xl border bg-card p-2.5 transition-colors",
                  "hover:border-foreground/20",
                  selected && "border-primary ring-1 ring-primary",
                )}
              >
                <button
                  type="button"
                  disabled={!v.previewUrl}
                  className="relative grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
                  style={{ backgroundColor: accent }}
                  aria-label={
                    playing
                      ? t("audio.elevenLabs.pausePreviewAriaLabel", { name: v.name })
                      : t("audio.elevenLabs.playPreviewAriaLabel", { name: v.name })
                  }
                  onClick={() => togglePreview(v)}
                >
                  {playing && (
                    <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:animate-none" style={{ backgroundColor: accent }} />
                  )}
                  <span className={cn("transition-opacity", playing ? "opacity-0" : v.previewUrl && "group-hover/card:opacity-0")}>
                    {v.name.charAt(0)}
                  </span>
                  {v.previewUrl && (
                    <span
                      aria-hidden
                      className={cn("absolute inset-0 grid place-items-center transition-opacity", playing ? "opacity-100" : "opacity-0 group-hover/card:opacity-100")}
                    >
                      {playing ? <Pause className="size-4 fill-current" /> : <Play className="ms-0.5 size-4 fill-current" />}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  className="min-w-0 flex-1 text-start outline-none focus-visible:underline"
                  aria-pressed={selected}
                  aria-label={t("audio.elevenLabs.selectVoiceAriaLabel", { name: v.name })}
                  onClick={() => onSelect(v)}
                >
                  <span className="flex items-center gap-1.5 truncate leading-5">
                    <span className="truncate text-sm font-medium">{v.name}</span>
                    <Badge variant={v.category === "cloned" ? "secondary" : "soft"} className="h-4 shrink-0 px-1.5 text-[10px]">
                      {t(ELEVENLABS_CATEGORY_LABEL_KEYS[v.category])}
                    </Badge>
                  </span>
                  {chips.length > 0 && (
                    <span className="block truncate text-[11px] capitalize text-muted-foreground">{chips.join(" · ")}</span>
                  )}
                </button>
                {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
              </li>
            )
          })}
        </ul>
      )}

      {load.status === "ready" && load.nextPageToken && (
        <Button type="button" variant="ghost" size="sm" className="w-full" disabled={moreBusy} onClick={() => void loadMore()}>
          {t("audio.elevenLabs.loadMore")}
        </Button>
      )}
    </div>
  )
}
