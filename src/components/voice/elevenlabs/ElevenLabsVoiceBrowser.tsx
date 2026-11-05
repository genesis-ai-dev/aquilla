// The connected ElevenLabs account's voices as a grid (AQU-2299), in the same
// card style as CharacterVoicePicker: the avatar previews the voice
// (ElevenLabs' own preview_url), the card says its name and one muted line
// ("Premade · American · Female"), and clicking the card selects it (ring + ✓).
// The last card, "Clone a voice", opens the clone step. Search only appears
// when the account has more voices than fit at a glance.
import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Pause, Play, Plus, Search } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { VOICE_PALETTE } from "@/lib/audio/voices"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { listElevenLabsVoices, type ElevenLabsVoiceRow } from "@/lib/sync/elevenlabs"
import type { FrontierSession } from "@/lib/frontier/types"
import { ELEVENLABS_CATEGORY_LABEL_KEYS, voiceLabelChips } from "./helpers"

/** Above this many voices the grid gets a search box. */
export const ELEVENLABS_SEARCH_THRESHOLD = 12

function accentFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return VOICE_PALETTE[h % VOICE_PALETTE.length] ?? VOICE_PALETTE[0]
}

// CharacterVoicePicker's card, copied rather than shared so that picker's
// markup stays exactly as it is.
const CARD = "group/card relative flex items-center gap-2.5 rounded-xl border bg-card p-2.5 transition-colors hover:border-foreground/20"

export interface ElevenLabsVoiceBrowserProps {
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** The connected key; the list reloads when it changes. */
  apiKey: string
  selectedId?: string
  onSelect: (voice: ElevenLabsVoiceRow) => void
  /** Shows the trailing "Clone a voice" card when given. */
  onClone?: () => void
  /** Bump to re-fetch (e.g. after a clone). */
  reloadToken?: number
  /** A voice to show even before the account list catches up (a fresh clone). */
  pinned?: ElevenLabsVoiceRow | null
}

type Load =
  | { status: "loading" }
  | { status: "ready"; voices: ElevenLabsVoiceRow[]; nextPageToken: string | null }
  | { status: "error"; message: string }

const errorText = (e: unknown) => categorizeAiError(e instanceof Error ? e.message : String(e)).body

export function ElevenLabsVoiceBrowser({
  projectId, fileId, session, apiKey, selectedId, onSelect, onClone, reloadToken = 0, pinned,
}: ElevenLabsVoiceBrowserProps) {
  const t = useT()
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [result, setResult] = useState<{ id: string; load: Load } | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  // Sticky: once the account shows it has many voices, search stays put even
  // while a narrow query is showing only a few.
  const [manyVoices, setManyVoices] = useState(false)

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
      .then((page) => {
        if (!live) return
        setResult({ id: requestId, load: { status: "ready", ...page } })
        if (!search && (page.voices.length > ELEVENLABS_SEARCH_THRESHOLD || page.nextPageToken)) setManyVoices(true)
      })
      .catch((e: unknown) => { if (live) setResult({ id: requestId, load: { status: "error", message: errorText(e) } }) })
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
      setResult({ id: requestId, load: { status: "error", message: errorText(e) } })
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
  const shown = pinned && !fetched.some((v) => v.id === pinned.id) ? [pinned, ...fetched] : fetched

  const cloneCard = onClone && (
    <li className={cn(CARD, "border-dashed bg-transparent")}>
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
        <Plus className="size-4" />
      </span>
      <button
        type="button"
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onClone}
        aria-label={t("audio.elevenLabs.cloneCard")}
      />
      <p className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-muted-foreground group-hover/card:text-foreground">
        {t("audio.elevenLabs.cloneCard")}
      </p>
    </li>
  )

  return (
    <div className="space-y-2.5">
      {(manyVoices || query) && (
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
      )}

      {load.status === "error" ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="min-w-0 text-xs text-destructive" role="alert">{load.message}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>{t("common.retry")}</Button>
        </div>
      ) : load.status === "loading" && shown.length === 0 ? (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-busy="true" aria-label={t("audio.elevenLabs.loadingVoices")}>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-xl border p-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                {i === 0 ? <LoadingCursor className="text-xs" /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {shown.length === 0 && search && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("audio.elevenLabs.noVoices")}</p>
          )}
          <ul className="grid max-h-[22rem] grid-cols-1 gap-1.5 overflow-y-auto pe-1 sm:grid-cols-2">
            {shown.map((v) => {
              const selected = v.id === selectedId
              const playing = playingId === v.id
              const accent = accentFor(v.id)
              const subtitle = [t(ELEVENLABS_CATEGORY_LABEL_KEYS[v.category]), ...voiceLabelChips(v.labels)].join(" · ")
              return (
                <li key={v.id} className={cn(CARD, selected && "border-primary ring-1 ring-primary")}>
                  {/* The whole card selects; the avatar sits above it and previews. */}
                  <button
                    type="button"
                    className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-pressed={selected}
                    aria-label={t("audio.elevenLabs.selectVoiceAriaLabel", { name: v.name })}
                    onClick={() => onSelect(v)}
                  />
                  <button
                    type="button"
                    disabled={!v.previewUrl}
                    className={cn(
                      "relative grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white",
                      "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
                    )}
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

                  <div className="pointer-events-none min-w-0 flex-1 pe-7">
                    <p className="truncate text-sm font-medium leading-5">{v.name}</p>
                    <p className="truncate text-[11px] capitalize text-muted-foreground">{subtitle}</p>
                  </div>

                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute end-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full transition-colors",
                      selected ? "text-primary" : "text-muted-foreground group-hover/card:bg-primary/15 group-hover/card:text-primary",
                    )}
                  >
                    {selected ? <Check className="size-4" /> : <Plus className="size-4" />}
                  </span>
                </li>
              )
            })}
            {cloneCard}
          </ul>
        </>
      )}

      {load.status === "ready" && load.nextPageToken && (
        <div className="text-center">
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={moreBusy} onClick={() => void loadMore()}>
            {t("audio.elevenLabs.loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}
