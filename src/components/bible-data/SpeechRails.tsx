// Voices (AQU-1687): speech rails at a cell's inline-start edge.
//
// One thin line per open quote level (up to 3), drawn by this row alone: a
// cap at the top where a speech begins in the cell, a cap at the bottom where
// it ends, a full-height line where it continues through. Level 1 is solid,
// level 2 dashed, level 3 double, so the level never depends on colour. The
// lines are a quiet neutral at rest and take the speaker's colour while the
// row is hovered. Screen readers get one sentence per speech instead
// ("Speech by Jesus begins").

import type { CSSProperties } from "react"
import { VOICE_PALETTE } from "@/lib/audio/voices"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"
import type { RailLevel, RailSegment, RailShape } from "@/lib/bible-data/speech-rails"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { CellVoiceView } from "./voices-context"
import { RAIL_STATE_KEYS } from "./voice-text"

/** Inline-start offset and line of each level, inside the row's 10px start padding. */
const RAIL_LINE: Readonly<Record<RailLevel, { offset: number; width: number; style: "solid" | "dashed" | "double" }>> = {
  1: { offset: 3, width: 2, style: "solid" },
  2: { offset: 6, width: 2, style: "dashed" },
  3: { offset: 9, width: 3, style: "double" },
}
/** How far a cap sits in from the row's edge, near the first or last text line. */
const CAP_INSET = "6px"
const CAP_WIDTH = 2

interface RailPiece {
  start: string
  end: string
  capStart: boolean
  capEnd: boolean
  speaker: BkpEntityId | undefined
}

/** The pieces one level draws, top to bottom. */
function piecesOf(shape: RailShape, speakers: readonly (BkpEntityId | undefined)[]): RailPiece[] {
  const first = speakers[0]
  const last = speakers[speakers.length - 1]
  switch (shape) {
    case "continue":
      return [{ start: "0px", end: "0px", capStart: false, capEnd: false, speaker: first }]
    case "begin":
      return [{ start: CAP_INSET, end: "0px", capStart: true, capEnd: false, speaker: last }]
    case "end":
      return [{ start: "0px", end: CAP_INSET, capStart: false, capEnd: true, speaker: first }]
    case "both":
      return [{ start: CAP_INSET, end: CAP_INSET, capStart: true, capEnd: true, speaker: first }]
    case "break":
      return [
        { start: "0px", end: "calc(50% + 2px)", capStart: false, capEnd: true, speaker: first },
        { start: "calc(50% + 2px)", end: "0px", capStart: true, capEnd: false, speaker: last },
      ]
  }
}

/** A stable palette colour per speaker, the same one the cast voices use. */
function speakerColor(speaker: BkpEntityId | undefined): string | undefined {
  if (!speaker) return undefined
  let hash = 0
  for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0
  return VOICE_PALETTE[hash % VOICE_PALETTE.length]
}

export function SpeechRails({ view }: { view: CellVoiceView }) {
  const t = useT()
  const fmt = useFormat()
  const segments: readonly RailSegment[] = view.rails
  if (segments.length === 0) return null
  const nameOf = (entityId: BkpEntityId | undefined): string =>
    (entityId ? view.context.labelFor(entityId)?.label : undefined) ?? t("bibleData.voices.unknownSpeaker")
  return (
    <div data-testid="speech-rails" className="pointer-events-none absolute inset-y-0 start-0 w-2.5">
      {segments.map(({ level, shape, speeches }) => {
        const line = RAIL_LINE[level]
        return piecesOf(shape, speeches.map(({ speech }) => speech.speaker)).map((piece, position) => {
          const color = speakerColor(piece.speaker)
          const style = {
            insetBlockStart: piece.start,
            insetBlockEnd: piece.end,
            insetInlineStart: `${line.offset}px`,
            inlineSize: `${line.width + 1}px`,
            borderInlineStartWidth: `${line.width}px`,
            borderInlineStartStyle: line.style,
            borderBlockStartWidth: piece.capStart ? `${CAP_WIDTH}px` : "0px",
            borderBlockStartStyle: "solid",
            borderBlockEndWidth: piece.capEnd ? `${CAP_WIDTH}px` : "0px",
            borderBlockEndStyle: "solid",
            ...(color ? { "--speaker-color": color } : {}),
          } as CSSProperties
          return (
            <span
              key={`${level}-${position}`}
              aria-hidden="true"
              data-rail-level={level}
              data-rail-shape={shape}
              data-rail-cap-start={piece.capStart ? "true" : undefined}
              data-rail-cap-end={piece.capEnd ? "true" : undefined}
              className="absolute border-muted-foreground/45 transition-colors motion-reduce:transition-none group-hover:[border-color:var(--speaker-color,currentColor)]"
              style={style}
            />
          )
        })
      })}
      <ul className="sr-only">
        {segments.flatMap(({ level, speeches }) =>
          speeches.map(({ speech, state }) => (
            <li key={`${level}-${speech.id}`}>
              {t(RAIL_STATE_KEYS[state], { speaker: fmt.isolate(nameOf(speech.speaker)) })}
            </li>
          )),
        )}
      </ul>
    </div>
  )
}
