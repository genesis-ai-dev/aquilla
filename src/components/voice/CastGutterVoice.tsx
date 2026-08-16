// The character gutter circle (2026-08-07 design): a small voice avatar at
// the far-left edge of a text-table row in the stacked media lens, aligned
// with the source's first text line. Hover names the character; click opens
// the voice picker. PURE assignment — picking a character never synthesizes
// (generation stays an explicit act elsewhere), matching the old detail
// pane's picker whose "Apply to all «name» lines" footer this inherits.
//
// Explicit casting renders solid; a line merely falling back to the default/
// narrator voice renders heavily faded inside a dotted ring so "nobody chose
// this" is obvious at a glance (Sam, 2026-08-07). A VTT import with speakers
// writes castAssignments, so imported cues correctly read as explicit.

import { useState } from "react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceAvatar } from "./VoiceAvatar"
import { VoicePickerContent } from "./VoiceCombobox"
import type { Voice } from "@/lib/parsers/types"

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
}

export function CastGutterVoice({ voice, explicit, castName, editable, voices, onPick }: CastGutterVoiceProps) {
  const [open, setOpen] = useState(false)
  const [applyToSpeaker, setApplyToSpeaker] = useState(false)
  // Hover text leads with the CHARACTER (Sam 2026-08-07) — the voice is the
  // detail, the name is the answer to "who is this circle?".
  const tooltip = explicit
    ? castName && castName !== voice.name
      ? `${castName} — voiced by ${voice.name}`
      : voice.name
    : `${voice.name} — default (no one cast yet)`
  const trigger = (
    <span
      className={cn(
        "grid place-items-center rounded-full",
        // Fallback: unmistakably "not chosen" — heavy fade + dotted ring.
        !explicit && "opacity-35 outline-dotted outline-1 outline-offset-1 outline-muted-foreground/60",
      )}
    >
      <VoiceAvatar voice={voice} size={32} />
    </span>
  )
  if (!editable) {
    return (
      <AppTooltip content={tooltip} side="right">
        <span data-testid="gutter-voice" data-explicit={String(explicit)} aria-label={tooltip}>
          {trigger}
        </span>
      </AppTooltip>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={tooltip} side="right">
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="gutter-voice"
              data-explicit={String(explicit)}
              aria-label={`${tooltip}. Choose a character`}
              className="rounded-full opacity-90 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
            />
          }
        >
          {trigger}
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="start" side="right" className="w-60 p-2">
        <VoicePickerContent
          voices={voices}
          activeId={explicit ? voice.id : undefined}
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
                Apply to all «{castName}» lines
              </label>
            ) : undefined
          }
        />
      </PopoverContent>
    </Popover>
  )
}
