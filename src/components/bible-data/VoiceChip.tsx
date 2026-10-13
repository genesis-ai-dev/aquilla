// Voices (AQU-1687): the chip in a Bible cell's row-corner label slot.
//
// "Narrator · Jesus → Samaritan woman", in reading order. With several
// speeches, the voices up to the first one plus "+N". Names come through the
// label chain and are bidi-isolated; the chip takes its direction from its
// own text (`dir="auto"`) and the arrow mirrors in a right-to-left run.
//
// Hover opens the details popover, and so does keyboard focus: hover is never
// the only way in. Focus stays on the chip, and Tab moves into the popover.

import { Fragment } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"
import type { Voice } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { VoiceDetails } from "./VoiceDetails"
import type { CellVoiceView } from "./voices-context"
import { useHoverFocusPopover } from "./use-hover-focus-popover"
import { narratorKey } from "./voice-text"

interface VoiceChipProps {
  view: CellVoiceView
  className?: string
}

export function VoiceChip({ view, className }: VoiceChipProps) {
  const t = useT()
  const fmt = useFormat()
  // AQU-1689: the hover-or-focus behavior is shared with Who's Who's mention words.
  const popover = useHoverFocusPopover()
  const { context, voices, chip } = view
  if (!chip) return null

  const nameOf = (entityId: BkpEntityId | undefined): string =>
    (entityId ? context.labelFor(entityId)?.label : undefined) ?? t("bibleData.voices.unknownSpeaker")
  /** The addressee's name, or null when the data names nobody (or nobody it knows). */
  const addresseeOf = (voice: Extract<Voice, { kind: "speech" }>): string | null =>
    (voice.speech.addressee ? context.labelFor(voice.speech.addressee)?.label : undefined) ?? null
  const narrator = t(narratorKey(context.index.narrator.kind))

  const spoken = chip.voices.map((voice) => {
    if (voice.kind === "narrator") return narrator
    const speaker = fmt.isolate(nameOf(voice.speech.speaker))
    const addressee = addresseeOf(voice)
    return addressee === null
      ? speaker
      : t("bibleData.voices.speaksTo", { speaker, addressee: fmt.isolate(addressee) })
  })
  if (chip.more > 0) spoken.push(t("bibleData.voices.moreVoices", { count: chip.more }))
  const ariaLabel = t(voices.approximate ? "bibleData.voices.chipAriaApproximate" : "bibleData.voices.chipAria", {
    voices: fmt.list(spoken),
  })

  return (
    <Popover open={popover.open} onOpenChange={popover.onOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={300}
        closeDelay={150}
        data-testid="voice-chip"
        data-voice-approximate={voices.approximate ? "true" : undefined}
        aria-label={ariaLabel}
        dir="auto"
        className={cn(
          "inline-block min-w-0 truncate rounded-sm text-start text-xs text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        {...popover.triggerProps}
      >
        {voices.approximate && (
          <span aria-hidden="true" className="me-0.5">
            ≈
          </span>
        )}
        {chip.voices.map((voice, position) => (
          <Fragment key={position}>
            {position > 0 && (
              <span aria-hidden="true" className="mx-1 opacity-60">
                ·
              </span>
            )}
            {voice.kind === "narrator" ? (
              narrator
            ) : (
              <>
                <bdi>{nameOf(voice.speech.speaker)}</bdi>
                {addresseeOf(voice) !== null && (
                  <>
                    <span aria-hidden="true" className="mx-0.5 inline-block rtl:-scale-x-100">
                      →
                    </span>
                    <bdi>{addresseeOf(voice)}</bdi>
                  </>
                )}
              </>
            )}
          </Fragment>
        ))}
        {chip.more > 0 && <span className="ms-1">{t("bibleData.voices.more", { count: chip.more })}</span>}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80" {...popover.contentProps}>
        <VoiceDetails id={popover.contentId} view={view} nameOf={nameOf} />
      </PopoverContent>
    </Popover>
  )
}
