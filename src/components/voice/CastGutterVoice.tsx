// The character gutter circle (2026-08-07 design): a small voice avatar at
// the far-left edge of a text-table row in the stacked media lens, aligned
// with the source's first text line. Hover names the character; click opens
// the voice picker. PURE assignment — picking a character never synthesizes
// (generation stays an explicit act elsewhere).
//
// SCOPE (Sam, Oct 23; replaces the "Apply to all «name» lines" checkbox): the
// footer asks how far the pick reaches — this line (the default every time the
// picker opens), every line of the character in this file, or the character in
// every episode. A line without a character has only the first.
//
// Explicit casting renders solid; a line merely falling back to the default/
// narrator voice renders as an EMPTY dashed ring marked "NC" (Sam, 2026-08-20,
// replacing the faded-orb-in-a-dotted-ring of 2026-08-07 — showing the
// fallback voice's face made "nobody chose this" look like a weak choice).
// A VTT import with speakers writes castAssignments, so imported cues
// correctly read as explicit.
//
// The Audio view opens the SAME picker from a field under each line's waveform
// (`variant="field"`, Sam, 2026-09-28): a gutter of circles beside every row
// unbalanced that page, and in narration nearly every circle is the Narrator.
//
// AQU-2212: in the field, a line nobody cast whose take is a person's recording
// names that recording ("Your recording"), not "Narrator (default)". The list
// ends with "Add a voice…", which opens New voice without leaving the line.

import { useState } from "react"
import { ChevronsUpDown, Mic, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { NoCharacterAvatar, VoiceAvatar } from "./VoiceAvatar"
import { VoicePickerContent } from "./VoiceCombobox"
import type { Voice } from "@/lib/parsers/types"
import type { CastScope } from "@/lib/audio/character-cast"
import { useT } from "@/lib/i18n/I18nProvider"

export interface CastGutterVoiceProps {
  /** The RESOLVED voice for this line (never undefined — default falls back). */
  voice: Voice
  /** True when the line is explicitly cast (assignment or per-cell pin that
   *  still resolves); false = default/narrator fallback → faded + dotted. */
  explicit: boolean
  /** The diarized/VTT speaker name, when the cell carries one. */
  castName: string | null
  /** False (read-only surfaces): the circle is informational, no picker. */
  editable: boolean
  voices: Voice[]
  onPick(voiceId: string, opts?: { scope?: CastScope }): void
  showLanguageBadge?: boolean
  /** Take the character off this line without replacing it (Matt's QA,
   *  2026-08-21). Offered only while the line carries one — an unassign row
   *  on an already-empty line is noise. Honours the footer's scope for this
   *  line or this file (Sam, same day: the footer must mean it for BOTH
   *  actions); removing a character from every episode is not offered. */
  onClear?(opts?: { scope?: CastScope }): void
  /** How many lines in this file share this line's cast name — asked when the
   *  picker opens, so the "this file" choice can say what it would change. */
  countSpeakerLines?(): number
  /** "circle" (default): the 32px circle in the Media view's gutter. "field":
   *  a field naming the voice, under a line's waveform in the Audio view. */
  variant?: "circle" | "field"
  /** Field only: what to call an uncast line's take when it is a person's
   *  recording ("Your recording"). The default voice is named otherwise. */
  takeLabel?: string
  /** Offer "Add a voice…" at the end of the list. */
  onAddVoice?(): void
}

export function CastGutterVoice({ voice, explicit, castName, editable, voices, onPick, onClear, countSpeakerLines, showLanguageBadge = false, variant = "circle", takeLabel, onAddVoice }: CastGutterVoiceProps) {
  const t = useT()
  const [open, setOpenState] = useState(false)
  const [speakerLines, setSpeakerLines] = useState<number | null>(null)
  const [scope, setScope] = useState<CastScope>("line")
  const setOpen = (next: boolean) => {
    if (next) {
      setSpeakerLines(countSpeakerLines ? countSpeakerLines() : null)
      // Every opening starts at "this line": a wider reach is chosen each time.
      setScope("line")
    }
    setOpenState(next)
  }
  // Without a character, a pick can only be for this line.
  const pickScope: CastScope = castName ? scope : "line"
  // Hover text leads with the CHARACTER (Sam 2026-08-07) — the voice is the
  // detail, the name is the answer to "who is this circle?".
  const tooltip = explicit
    ? castName && castName !== voice.name
      ? t("audio.castGutter.namedTooltip", { castName, voiceName: voice.name })
      : voice.name
    : variant === "field" && takeLabel
      ? t("audio.castGutter.recordingTooltip", { label: takeLabel })
      : t("audio.castGutter.defaultTooltip", { voiceName: voice.name })
  const field = variant === "field"
  const recording = field && !explicit && Boolean(takeLabel)
  const avatarPx = field ? 20 : 32
  const trigger = (
    <span className={cn("grid place-items-center rounded-md", field && "shrink-0")}>
      {/* Nothing is drawn for a line nobody cast — no face, no colour, no
          initial. The empty dashed ring IS the state; a faded orb read as a
          weak assignment rather than as none. */}
      {explicit ? (
        <VoiceAvatar voice={voice} size={avatarPx} />
      ) : recording ? (
        <span
          aria-hidden
          className="grid place-items-center rounded-full bg-muted text-muted-foreground"
          style={{ width: avatarPx, height: avatarPx }}
        >
          <Mic className="size-3" />
        </span>
      ) : (
        <NoCharacterAvatar size={avatarPx} />
      )}
    </span>
  )
  // The field names the voice beside its mark; nobody cast reads as the
  // default voice, muted.
  const fieldLabel = (
    <span className={cn("min-w-0 truncate", !explicit && "text-muted-foreground")}>
      {explicit ? voice.name : recording ? takeLabel : t("audio.castGutter.defaultVoiceLabel", { voiceName: voice.name })}
    </span>
  )
  const tooltipSide = field ? "top" : "right"
  // AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. The
  // gutter's avatar is wordless, so it keeps its name; the field shows the
  // voice in words beside its mark, so it has no hover.
  const hoverName = field ? null : tooltip
  if (!editable) {
    return (
      <AppTooltip content={hoverName} side={tooltipSide}>
        <span
          data-testid={field ? "voice-field" : "gutter-voice"}
          data-explicit={String(explicit)}
          aria-label={tooltip}
          className={cn(field && "flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground")}
        >
          {trigger}
          {field && fieldLabel}
        </span>
      </AppTooltip>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={hoverName} side={tooltipSide}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid={field ? "voice-field" : "gutter-voice"}
              data-explicit={String(explicit)}
              aria-label={t("audio.castGutter.chooseCharacterAriaLabel", { tooltip })}
              className={
                field
                  ? "flex h-7 w-56 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent/50"
                  : "rounded-md opacity-90 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
              }
            />
          }
        >
          {trigger}
          {field && (
            <>
              {fieldLabel}
              <ChevronsUpDown className="ms-auto size-3 shrink-0 text-muted-foreground" />
            </>
          )}
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="start" side={field ? "bottom" : "right"} className="w-60 p-2">
        <VoicePickerContent
          voices={voices}
          activeId={explicit ? voice.id : undefined}
          showLanguageBadge={showLanguageBadge}
          beforeList={
            // The way OUT of a casting: the first row of the cast list, same
            // shape as a voice. Shown only while the line carries a character
            // (an explicit voice, or a lingering name behind an NC ring — that
            // name still groups the exports, so it must be clearable too). The
            // NC ring as its icon: the row shows exactly what the line becomes.
            onClear && (explicit || castName) ? (
              <button
                type="button"
                data-testid="gutter-voice-clear"
                disabled={pickScope === "everywhere"}
                onClick={() => {
                  onClear({ scope: pickScope })
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <NoCharacterAvatar size={20} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{t("audio.castGutter.noCharacter")}</span>
                  {pickScope === "everywhere" && (
                    <span className="text-xs text-muted-foreground">{t("workspace.castGutterVoice.clearOneFileAtATime")}</span>
                  )}
                </span>
              </button>
            ) : undefined
          }
          onPick={(voiceId) => {
            onPick(voiceId, { scope: pickScope })
            setOpen(false)
          }}
          footer={
            <>
            {onAddVoice && (
              <button
                type="button"
                data-testid="gutter-voice-add"
                onClick={() => {
                  setOpen(false)
                  onAddVoice()
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm font-medium transition-colors hover:bg-accent/50"
              >
                <span className="grid size-5 place-items-center rounded-full border border-dashed border-muted-foreground text-muted-foreground">
                  <Plus className="size-3" />
                </span>
                {t("audio.castGutter.addVoice")}
              </button>
            )}
            {castName ? (
              <fieldset className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5 text-xs text-muted-foreground">
                <legend className="mb-0.5">{t("workspace.castGutterVoice.scopeLegend")}</legend>
                {(
                  [
                    ["line", t("workspace.castGutterVoice.scopeLine")],
                    [
                      "file",
                      speakerLines != null
                        ? t("workspace.castGutterVoice.scopeFileCount", { name: castName, count: speakerLines })
                        : t("workspace.castGutterVoice.scopeFile", { name: castName }),
                    ],
                    ["everywhere", t("workspace.castGutterVoice.scopeEverywhere", { name: castName })],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="cast-gutter-voice-scope"
                      data-testid={`gutter-voice-scope-${value}`}
                      className="mt-0.5"
                      value={value}
                      checked={scope === value}
                      onChange={() => setScope(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p data-testid="gutter-voice-scope-none" className="mt-1.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
                {t("workspace.castGutterVoice.scopeNoCharacter")}
              </p>
            )}
            </>
          }
        />
      </PopoverContent>
    </Popover>
  )
}
