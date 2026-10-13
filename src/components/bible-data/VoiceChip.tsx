// Voices (AQU-1687): the chip in a Bible cell's row-corner label slot.
//
// "Narrator · Jesus → Samaritan woman", in reading order. With several
// speeches, the voices up to the first one plus "+N". Names come through the
// label chain and are bidi-isolated; the chip takes its direction from its
// own text (`dir="auto"`) and the arrow mirrors in a right-to-left run.
//
// Hover opens the details popover, and so does keyboard focus: hover is never
// the only way in. Focus stays on the chip, and Tab moves into the popover.

import { Fragment, useId, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"
import type { Voice } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { VoiceDetails } from "./VoiceDetails"
import type { CellVoiceView } from "./voices-context"
import { narratorKey } from "./voice-text"

interface VoiceChipProps {
  view: CellVoiceView
  className?: string
}

export function VoiceChip({ view, className }: VoiceChipProps) {
  const t = useT()
  const fmt = useFormat()
  const [open, setOpen] = useState(false)
  // A click focuses the chip too; only keyboard focus should open it that way.
  const pointerDownRef = useRef(false)
  const openedByFocusRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const detailsId = useId()
  const { context, voices, chip } = view
  if (!chip) return null

  /** True when `node` is inside this chip's own popover. */
  const inOwnPopover = (node: EventTarget | null): boolean => {
    if (!(node instanceof Node)) return false
    const popup = document.getElementById(detailsId)?.closest('[data-slot="popover-content"]')
    return popup?.contains(node) ?? false
  }

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        openedByFocusRef.current = false
        setOpen(next)
      }}
    >
      <PopoverTrigger
        ref={triggerRef}
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
        onPointerDown={() => {
          pointerDownRef.current = true
        }}
        onFocus={() => {
          if (!pointerDownRef.current) {
            openedByFocusRef.current = true
            setOpen(true)
          }
          pointerDownRef.current = false
        }}
        onBlur={(event) => {
          // Opened by focus, so it closes when focus moves on, unless it
          // moves into the popover itself.
          if (openedByFocusRef.current && !inOwnPopover(event.relatedTarget)) {
            openedByFocusRef.current = false
            setOpen(false)
          }
        }}
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
      <PopoverContent
        side="bottom"
        align="start"
        className="w-80"
        // Opened by keyboard focus: keep focus on the chip (Tab moves in).
        // Opened by a press: move focus in, as a menu would.
        initialFocus={() => !openedByFocusRef.current}
        onBlur={(event) => {
          // Focus left the popover for somewhere other than its chip.
          const next = event.relatedTarget
          if (next instanceof Node && (event.currentTarget.contains(next) || triggerRef.current?.contains(next))) return
          openedByFocusRef.current = false
          setOpen(false)
        }}
      >
        <VoiceDetails id={detailsId} view={view} nameOf={nameOf} />
      </PopoverContent>
    </Popover>
  )
}
