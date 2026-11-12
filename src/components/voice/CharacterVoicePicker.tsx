// CharacterVoicePicker — the "Characters" tab of NewVoiceModal: the pre-built
// cast (src/lib/audio/character-voices.ts) as a compact grid. Each card's avatar
// previews the voice; ＋ adds it to the project's cast in one tap (or, while
// editing a character voice, the card re-points it). Each card says only who
// the voice is (sex, age) and its range; chips filter by sex and age.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Check, Pause, Play, Plus } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { VOICE_PALETTE } from "@/lib/audio/voices"
import {
  CHARACTER_VOICE_FILTERS,
  CHARACTER_VOICES,
  characterVoicePreviewUrl,
  filterCharacterVoices,
  type CharacterVoice,
  type CharacterVoiceAge,
  type CharacterVoiceFilter,
  type CharacterVoiceRange,
} from "@/lib/audio/character-voices"

export interface CharacterVoicePickerProps {
  /** The character the voice being edited points at; highlighted. */
  selectedId?: string
  /** Characters already in the project's cast — marked, and not offered again. */
  inCastIds?: ReadonlySet<string>
  onPick: (character: CharacterVoice) => void
  /** Editing re-points the voice ("Use"); creating adds a new cast member ("Add"). */
  editing?: boolean
  /** While editing, the voice's name is shown above the grid and stays editable. */
  name?: string
  onNameChange?: (name: string) => void
}

const FILTER_LABEL_KEYS = {
  female: "audio.characters.filterFemale",
  male: "audio.characters.filterMale",
  young: "audio.characters.filterYoung",
  "middle-aged": "audio.characters.filterMiddleAged",
  old: "audio.characters.filterOld",
} as const satisfies Record<CharacterVoiceFilter, string>

const AGE_LABEL_KEYS = {
  young: FILTER_LABEL_KEYS.young,
  "middle-aged": FILTER_LABEL_KEYS["middle-aged"],
  old: FILTER_LABEL_KEYS.old,
} as const satisfies Record<CharacterVoiceAge, string>

const RANGE_LABEL_KEYS = {
  treble: "audio.characters.rangeTreble",
  soprano: "audio.characters.rangeSoprano",
  mezzo: "audio.characters.rangeMezzo",
  alto: "audio.characters.rangeAlto",
  tenor: "audio.characters.rangeTenor",
  baritone: "audio.characters.rangeBaritone",
  bass: "audio.characters.rangeBass",
} as const satisfies Record<CharacterVoiceRange, string>

/** A stable accent per character, from the cast palette. */
function accentFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return VOICE_PALETTE[h % VOICE_PALETTE.length] ?? VOICE_PALETTE[0]
}

export function CharacterVoicePicker({ selectedId, inCastIds, onPick, editing = false, name, onNameChange }: CharacterVoicePickerProps) {
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
      {editing && onNameChange && (
        <Field>
          <FieldLabel htmlFor="voice-name">{t("common.name")}</FieldLabel>
          <Input
            id="voice-name"
            value={name ?? ""}
            onChange={(e) => onNameChange(e.target.value)}
            className="h-10"
            aria-label={t("audio.newVoice.nameAriaLabel")}
          />
        </Field>
      )}

      <div className="flex flex-wrap gap-1" role="group" aria-label={t("audio.characters.filterGroupAriaLabel")}>
        {CHARACTER_VOICE_FILTERS.map((f) => (
          <Toggle
            key={f}
            size="sm"
            variant="outline"
            pressed={filters.includes(f)}
            onPressedChange={() => toggleFilter(f)}
            className="h-6 rounded-full px-2.5 text-[11px] text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
          >
            {t(FILTER_LABEL_KEYS[f])}
          </Toggle>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("audio.characters.noMatches")}</p>
      ) : (
        <ul className="grid max-h-[22rem] grid-cols-1 gap-1.5 overflow-y-auto pe-1 sm:grid-cols-2">
          {shown.map((c) => {
            const selected = c.id === selectedId
            const inCast = !editing && (inCastIds?.has(c.id) ?? false)
            const playing = playingId === c.id
            const accent = accentFor(c.id)
            return (
              <li
                key={c.id}
                ref={selected ? selectedRowRef : undefined}
                className={cn(
                  "group/card relative flex items-center gap-2.5 rounded-xl border bg-card p-2.5 transition-colors",
                  "hover:border-foreground/20",
                  selected && "border-primary ring-1 ring-primary",
                )}
              >
                {/* The avatar is the preview control: initial at rest, play on hover, pause while playing. */}
                <button
                  type="button"
                  className={cn(
                    "relative grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white",
                    "outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  )}
                  style={{ backgroundColor: accent }}
                  aria-label={
                    playing
                      ? t("audio.characters.pauseAriaLabel", { name: c.name })
                      : t("audio.characters.previewAriaLabel", { name: c.name })
                  }
                  onClick={() => togglePreview(c.id)}
                >
                  {playing && (
                    <span
                      aria-hidden
                      className="absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:animate-none"
                      style={{ backgroundColor: accent }}
                    />
                  )}
                  <span className={cn("transition-opacity", (playing ? "opacity-0" : "group-hover/card:opacity-0"))}>
                    {c.name.charAt(0)}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-0 grid place-items-center transition-opacity",
                      playing ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
                    )}
                  >
                    {playing ? <Pause className="size-4 fill-current" /> : <Play className="ms-0.5 size-4 fill-current" />}
                  </span>
                </button>

                <div className="min-w-0 flex-1 pe-7">
                  <p className="flex items-baseline gap-1.5 truncate leading-5">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-[11px] text-muted-foreground">{t(RANGE_LABEL_KEYS[c.range])}</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t(FILTER_LABEL_KEYS[c.sex])} · {t(AGE_LABEL_KEYS[c.age])}
                  </p>
                </div>

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "absolute end-1.5 top-1/2 size-7 -translate-y-1/2 rounded-full",
                    !(selected || inCast) && "text-muted-foreground hover:bg-primary/15 hover:text-primary",
                  )}
                  disabled={selected || inCast}
                  aria-label={
                    selected
                      ? t("audio.characters.currentAriaLabel", { name: c.name })
                      : inCast
                        ? t("audio.characters.inCastAriaLabel", { name: c.name })
                        : editing
                          ? t("audio.characters.useAriaLabel", { name: c.name })
                          : t("audio.characters.addAriaLabel", { name: c.name })
                  }
                  onClick={() => onPick(c)}
                >
                  {selected || inCast ? <Check className="size-4" /> : <Plus className="size-4" />}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-center text-[11px] text-muted-foreground">{t("audio.characters.footnote")}</p>
    </div>
  )
}
