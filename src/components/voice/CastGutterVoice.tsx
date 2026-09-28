// The character gutter circle (2026-08-07 design): a small voice avatar at
// the far-left edge of a text-table row in the stacked media lens, aligned
// with the source's first text line. Hover names the character; click opens
// the voice picker. PURE assignment — picking a character never synthesizes
// (generation stays an explicit act elsewhere), matching the old detail
// pane's picker whose "Apply to all «name» lines" footer this inherits.
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

import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { NoCharacterAvatar, VoiceAvatar } from "./VoiceAvatar"
import { VoicePickerContent } from "./VoiceCombobox"
import type { Voice } from "@/lib/parsers/types"
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
  onPick(voiceId: string, opts?: { applyToSpeaker?: boolean }): void
  showLanguageBadge?: boolean
  /** Take the character off this line without replacing it (Matt's QA,
   *  2026-08-21). Offered only while the line carries one — an unassign row
   *  on an already-empty line is noise. Honours the same apply-to-speaker
   *  checkbox the picker does (Sam, same day): the footer promises "all
   *  «name» lines" and must mean it for BOTH actions. */
  onClear?(opts?: { applyToSpeaker?: boolean }): void
  /** How many lines share this line's cast name — asked when the picker
   *  opens, so the apply-to-all box can say what it would change. */
  countSpeakerLines?(): number
  /** "circle" (default): the 32px circle in the Media view's gutter. "field":
   *  a field naming the voice, under a line's waveform in the Audio view. */
  variant?: "circle" | "field"
}

export function CastGutterVoice({ voice, explicit, castName, editable, voices, onPick, onClear, countSpeakerLines, showLanguageBadge = false, variant = "circle" }: CastGutterVoiceProps) {
  const t = useT()
  const [open, setOpenState] = useState(false)
  const [speakerLines, setSpeakerLines] = useState<number | null>(null)
  const setOpen = (next: boolean) => {
    if (next) setSpeakerLines(countSpeakerLines ? countSpeakerLines() : null)
    setOpenState(next)
  }
  const [applyToSpeaker, setApplyToSpeaker] = useState(false)
  // Hover text leads with the CHARACTER (Sam 2026-08-07) — the voice is the
  // detail, the name is the answer to "who is this circle?".
  const tooltip = explicit
    ? castName && castName !== voice.name
      ? t("audio.castGutter.namedTooltip", { castName, voiceName: voice.name })
      : voice.name
    : t("audio.castGutter.defaultTooltip", { voiceName: voice.name })
  const field = variant === "field"
  const avatarPx = field ? 20 : 32
  const trigger = (
    <span className={cn("grid place-items-center rounded-md", field && "shrink-0")}>
      {/* Nothing is drawn for a line nobody cast — no face, no colour, no
          initial. The empty dashed ring IS the state; a faded orb read as a
          weak assignment rather than as none. */}
      {explicit ? <VoiceAvatar voice={voice} size={avatarPx} /> : <NoCharacterAvatar size={avatarPx} />}
    </span>
  )
  // The field names the voice beside its mark; nobody cast reads as the
  // default voice, muted.
  const fieldLabel = (
    <span className={cn("min-w-0 truncate", !explicit && "text-muted-foreground")}>
      {explicit ? voice.name : t("audio.castGutter.defaultVoiceLabel", { voiceName: voice.name })}
    </span>
  )
  const tooltipSide = field ? "top" : "right"
  if (!editable) {
    return (
      <AppTooltip content={tooltip} side={tooltipSide}>
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
      <AppTooltip content={tooltip} side={tooltipSide}>
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
        {/* The way OUT of a casting, above the ways in. Shown only while the
            line carries a character (an explicit voice, or a lingering name
            behind an NC ring — that name still groups the exports, so it must
            be clearable too). The NC ring as its icon: the row shows exactly
            what the line becomes. */}
        {onClear && (explicit || castName) && (
          <button
            type="button"
            data-testid="gutter-voice-clear"
            onClick={() => {
              onClear({ applyToSpeaker })
              setOpen(false)
            }}
            className="mb-1.5 flex w-full items-center gap-2 rounded-md border-b border-border px-2 pb-2 pt-1.5 text-start text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <NoCharacterAvatar size={20} />
            <span className="min-w-0 flex-1 truncate">{t("audio.castGutter.noCharacter")}</span>
          </button>
        )}
        <VoicePickerContent
          voices={voices}
          activeId={explicit ? voice.id : undefined}
          showLanguageBadge={showLanguageBadge}
          onPick={(voiceId) => {
            onPick(voiceId, { applyToSpeaker })
            setOpen(false)
          }}
          footer={
            castName ? (
              <label className="mt-1.5 flex cursor-pointer items-center gap-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  data-testid="gutter-voice-all"
                  checked={applyToSpeaker}
                  onChange={(e) => setApplyToSpeaker(e.target.checked)}
                />
                {speakerLines != null
                  ? t("workspace.castGutterVoice.applyToAllLinesCount", { name: castName ?? "", count: speakerLines })
                  : t("workspace.castGutterVoice.applyToAllLines", { name: castName ?? "" })}
              </label>
            ) : undefined
          }
        />
      </PopoverContent>
    </Popover>
  )
}
