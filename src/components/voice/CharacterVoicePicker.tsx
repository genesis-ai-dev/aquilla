// CharacterVoicePicker — the "Characters" tab of NewVoiceModal: the pre-built
// cast (src/lib/audio/character-voices.ts) as preview cards. One click on a
// card's action adds that character to the project's cast (or, while editing a
// character voice, re-points it); the play button previews the voice. Filter
// chips narrow by sex and age band.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Check, Pause, Play, Plus } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import {
  CHARACTER_VOICE_FILTERS,
  CHARACTER_VOICES,
  characterVoicePreviewUrl,
  filterCharacterVoices,
  type CharacterVoice,
  type CharacterVoiceFilter,
} from "@/lib/audio/character-voices"

export interface CharacterVoicePickerProps {
  /** The character the voice being edited points at; highlighted. */
  selectedId?: string
  /** Characters already in the project's cast — marked, and not offered again. */
  inCastIds?: ReadonlySet<string>
  onPick: (character: CharacterVoice) => void
  /** Editing re-points the voice ("Use"); creating adds a new cast member ("Add"). */
  editing?: boolean
}

const FILTER_LABEL_KEYS = {
  female: "audio.characters.filterFemale",
  male: "audio.characters.filterMale",
  child: "audio.characters.filterChild",
  teen: "audio.characters.filterTeen",
  "young-adult": "audio.characters.filterYoungAdult",
  adult: "audio.characters.filterAdult",
  elderly: "audio.characters.filterElderly",
} as const satisfies Record<CharacterVoiceFilter, string>

export function CharacterVoicePicker({ selectedId, inCastIds, onPick, editing = false }: CharacterVoicePickerProps) {
  const t = useT()
  const [filters, setFilters] = useState<CharacterVoiceFilter[]>([])
  const shown = useMemo(() => filterCharacterVoices(CHARACTER_VOICES, filters), [filters])

  // Editing opens on the voice's current character, wherever it sits in the list.
  const selectedRowRef = useRef<HTMLLIElement | null>(null)
  useLayoutEffect(() => {
    selectedRowRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [])

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const stop = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingId(null)
  }, [])
  useEffect(() => () => stop(), [stop])

  const togglePreview = useCallback((id: string) => {
    if (playingId === id) {
      stop()
      return
    }
    stop()
    const audio = new Audio(characterVoicePreviewUrl(id))
    audioRef.current = audio
    audio.onended = () => stop()
    setPlayingId(id)
    audio.play().catch(() => stop())
  }, [playingId, stop])

  const toggleFilter = (f: CharacterVoiceFilter) =>
    setFilters((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]))

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("audio.characters.intro")}</p>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("audio.characters.filterGroupAriaLabel")}>
        {CHARACTER_VOICE_FILTERS.map((f) => (
          <Toggle
            key={f}
            size="sm"
            variant="outline"
            pressed={filters.includes(f)}
            onPressedChange={() => toggleFilter(f)}
            className="h-7 rounded-full px-3 text-xs aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
          >
            {t(FILTER_LABEL_KEYS[f])}
          </Toggle>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("audio.characters.noMatches")}</p>
      ) : (
        <ul className="grid max-h-[22rem] grid-cols-1 gap-2 overflow-y-auto pe-1">
          {shown.map((c) => {
            const selected = c.id === selectedId
            const inCast = !editing && (inCastIds?.has(c.id) ?? false)
            const playing = playingId === c.id
            return (
              <li
                key={c.id}
                ref={selected ? selectedRowRef : undefined}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card p-3",
                  selected && "border-primary ring-1 ring-primary",
                )}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="mt-0.5 shrink-0 rounded-full"
                  aria-label={
                    playing
                      ? t("audio.characters.pauseAriaLabel", { name: c.name })
                      : t("audio.characters.previewAriaLabel", { name: c.name })
                  }
                  onClick={() => togglePreview(c.id)}
                >
                  {playing ? <Pause /> : <Play />}
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{c.name}</span>
                    {c.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={selected || inCast ? "ghost" : "secondary"}
                  className="shrink-0"
                  disabled={selected || inCast}
                  onClick={() => onPick(c)}
                >
                  {selected || inCast ? <Check /> : editing ? null : <Plus />}
                  {selected
                    ? t("audio.characters.current")
                    : inCast
                      ? t("audio.characters.inCast")
                      : editing
                        ? t("audio.characters.use")
                        : t("audio.characters.add")}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-[11px] text-muted-foreground">{t("audio.characters.howItWorks")}</p>
    </div>
  )
}
