// AQU-1278: one planning unit's chapters as a grid of tiles.
//
// This replaces AQU-1098's stack of per-chapter bars. Two bars per chapter is
// the right answer for one chapter and the wrong one for a book: twenty-one
// rows needed a scroller inside a panel that already scrolls, and Psalms' 150
// were unreadable at any height the inspector can afford. A grid puts a whole
// book on screen at once and answers the only question the inspector asks of a
// chapter — is anything still outstanding in it, and in which medium. The bars
// are not gone; selecting a tile brings that chapter's own pair back, which is
// the case they were always good at.
//
// COLOUR IS NEVER THE ONLY CARRIER, the same rule plan-tone.ts states for the
// status colours. Every tile keeps its number, carries an aria-label saying how
// many cells are short, and the legend names each swatch in words, so the grid
// survives a greyscale print and a colour-blind reader.

import { useT } from "@/lib/i18n/I18nProvider"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import { planUnitShortfall, type PlanShortfall } from "@/lib/plan/plan-status"
import type { PlanSection } from "@/hooks/usePlanUnitSections"
import { hexToRgba, parseTrackHue } from "@/lib/timeline/track-colors"

/**
 * The timeline's own hues, looked up by preset id exactly as `PlanBar` does, so
 * a retune in `track-colors.ts` lands on the bars and the tiles together. Two
 * surfaces that mean the same thing must never be tinted from two tables.
 */
const HUE = {
  text: parseTrackHue("azure"),
  audio: parseTrackHue("cyan"),
} as const

/**
 * THE UNDERLINE'S LADDER IS NOT THE BARS' LADDER, and that is deliberate rather
 * than an oversight. `PlanBar` fills a whole 8px track, where 0.33 is plainly
 * visible; this is a three-pixel line under a tile the size of a fingernail, and
 * at a third alpha it disappears into the tile's own surface. So it starts at
 * half and climbs from there: a chapter missing everything draws at full
 * strength, one missing a couple of cells still draws hard enough to find.
 */
function underlineAlpha(short: number, total: number): number {
  if (short <= 0 || total <= 0) return 0
  return Math.min(1, 0.5 + short / total)
}

/** The legend swatch sits at the middle of that ladder — a representative rung. */
const LEGEND_ALPHA = 0.75

/**
 * The chapter number a section key carries, or null when it is not a chapter at
 * all.
 *
 * TWO TRAPS LIVE IN THIS FUNCTION, and both of them put a tile in the wrong
 * square rather than failing loudly.
 *
 * The first is `usePlanUnitSections`' own `sectionLabel`, which is looser on
 * purpose — it only has to produce something to print, so it reads "Scene 4" as
 * "4". A grid POSITIONS by this number, so borrowing that rule would sit scene
 * four in chapter four's square and leave a document file looking like a book
 * with holes in it.
 *
 * The second is subtler: "Act 2" passes any book-code test you write, because
 * ACT is Acts. A section key is machine-made from `canonical_ref` and a USFM
 * book code is upper case in every one of them; a human-written section name in
 * a document is not. Requiring the prefix to be upper case AS WELL AS a known
 * code is what separates "ACT 2" (Acts, chapter two) from "Act 2" (the second
 * act of something), and there is no other signal in the key that can.
 */
export function planTileChapter(key: string): number | null {
  const match = /^(\S+)\s+(\d+)$/.exec(key)
  if (!match) return null
  const [, prefix, chapter] = match
  if (prefix !== prefix.toUpperCase()) return null
  if (!isKnownBookCode(prefix)) return null
  const n = Number(chapter)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * One chapter's outstanding work, measured by the unit rule.
 *
 * Routed through `planUnitShortfall` rather than subtracting here, because that
 * function owns two decisions a second copy would quietly get wrong: every term
 * is clamped at zero (a book whose headings were recorded reports more audio
 * than cells — see its own note), and `AUDIO_JUDGED_ON_RECORDED` decides whether
 * audio counts validation at all. When AQU-490 lands and that constant flips,
 * the tiles flip with it instead of contradicting the row above them.
 */
export function planSectionShortfall(section: PlanSection, hasAudio: boolean): PlanShortfall {
  return planUnitShortfall(
    {
      fileId: "",
      fileName: "",
      sectionKey: section.key,
      totalCount: section.totalCount,
      filledCount: section.filledCount,
      validatedCount: section.validatedCount,
      audioCount: section.audioCount,
      audioValidatedCount: section.audioValidatedCount,
      lastEditAt: null,
      targetDate: null,
      doneAt: null,
      doneBy: null,
    },
    hasAudio,
  )
}

interface TileFacts {
  /** Cells with no target text or no validation — the left half of the underline. */
  textShort: number
  /** Cells with no take (and, once AQU-490 ships, no sign-off) — the right half. */
  audioShort: number
  /** The worse medium, which is the number the badge and the aria-label say. */
  worst: number
}

function tileFacts(section: PlanSection, hasAudio: boolean): TileFacts {
  const s = planSectionShortfall(section, hasAudio)
  return {
    textShort: s.toTranslate + s.toValidate,
    audioShort: s.toRecord + s.toAudioValidate,
    worst: s.worst,
  }
}

export function PlanChapterGrid({
  sections, showAudio, nearlyComplete, selectedKey, onSelect,
}: {
  /** Already narrowed to this unit by `usePlanUnitSections`. */
  sections: readonly PlanSection[]
  /** Whether this project records audio at all; the right half is drawn only then. */
  showAudio: boolean
  /**
   * AQU-1278: only a nearly-complete unit's tiles carry a count.
   *
   * Below that threshold every short tile would show a two-digit number and the
   * grid stops being a shape you can read at a glance — which is the whole
   * reason it replaced a list. Six alternatives were tried (a number on every
   * tile, on hover only, on the worst five, a dot ladder, a tooltip, nothing at
   * all) and this is the settled answer: the numbers appear exactly when they
   * are small enough to matter.
   */
  nearlyComplete: boolean
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const t = useT()

  // A media file's sections are all five-minute time buckets ("t:300000"), and
  // `sectionBelongsToUnit` rejects every one of them — so a dubbed episode
  // arrives here with an empty list, not a short one. Saying why beats an empty
  // frame, which every reader reads as a load that failed.
  if (sections.length === 0) {
    return (
      <p data-testid="plan-grid-empty" className="text-[11.5px] leading-relaxed text-muted-foreground">
        {t("org.projectOverview.plan.gridEmptyMedia")}
      </p>
    )
  }

  // POSITION BY THE PARSED NUMBER, NEVER BY ARRAY INDEX. A section row exists
  // only where cells exist, and AQU-1083's structural subtraction can empty one
  // out of the response entirely — so chapters are not contiguous. Indexed by
  // position, a single missing chapter shifts every later tile by one square and
  // the grid lies about every chapter after it, silently and plausibly.
  const byChapter = new Map<number, PlanSection>()
  const extras: PlanSection[] = []
  let highest = 0
  for (const section of sections) {
    const chapter = planTileChapter(section.key)
    if (chapter == null) {
      extras.push(section)
      continue
    }
    byChapter.set(chapter, section)
    if (chapter > highest) highest = chapter
  }

  // Ten across fits the panel at a comfortable tile size and makes the decades
  // countable down the left edge. Psalms' 150 chapters would be fifteen rows of
  // that, so past sixty the grid trades a little tile size for twelve columns
  // and stays inside the panel without a scroller of its own.
  const columns = highest > 60 ? "grid-cols-12" : "grid-cols-10"
  const squares = Array.from({ length: highest }, (_, i) => i + 1)

  return (
    <div className="flex flex-col gap-2">
      {highest > 0 && (
        <div data-testid="plan-chapter-grid" className={`grid gap-[3px] ${columns}`}>
          {squares.map((chapter) => {
            const section = byChapter.get(chapter)
            // The gap. It holds the square open so chapter 12 stays under
            // chapter 2, and draws nothing, because nothing is what is there.
            if (!section) {
              return (
                <span
                  key={`gap-${chapter}`}
                  data-testid={`plan-tile-gap-${chapter}`}
                  aria-hidden
                  className="aspect-square"
                />
              )
            }
            return (
              <PlanTile
                key={section.key}
                section={section}
                label={String(chapter)}
                ariaSubject={String(chapter)}
                showAudio={showAudio}
                showCount={nearlyComplete}
                selected={selectedKey === section.key}
                onSelect={onSelect}
              />
            )
          })}
        </div>
      )}

      {/* Everything a numbered grid cannot hold, in its own row beneath it,
          each labelled with the key it actually has. Three shapes end up here:
          USFM front matter, which comes back as a bare book code ("GEN"); a
          one-chapter book, whose section key IS its book code ("TIT"); and a
          document file's own section names ("Scene 4", "Act 2"). Putting them
          in the grid would mean inventing a chapter number for each. */}
      {extras.length > 0 && (
        <div data-testid="plan-chapter-extras" className="flex flex-wrap gap-[3px]">
          {extras.map((section) => (
            <PlanTile
              key={section.key}
              section={section}
              label={section.key}
              ariaSubject={section.key}
              wide
              showAudio={showAudio}
              showCount={nearlyComplete}
              selected={selectedKey === section.key}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      <div
        data-testid="plan-grid-legend"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground"
      >
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-muted" />
          {t("org.projectOverview.plan.gridLegendComplete")}
        </span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{ backgroundColor: hexToRgba(HUE.text, LEGEND_ALPHA) }}
          />
          {t("org.projectOverview.plan.gridLegendTextShort")}
        </span>
        {/* Named only where the grid can draw it. On a text-only project the
            audio half of every underline is transparent, and a legend entry for
            a colour that is nowhere on screen is a question, not an answer. */}
        {showAudio && (
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ backgroundColor: hexToRgba(HUE.audio, LEGEND_ALPHA) }}
            />
            {t("org.projectOverview.plan.gridLegendAudioShort")}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * One tile.
 *
 * A finished chapter is QUIET — the muted surface the panel already uses, so a
 * finished book reads as a calm block and the eye is drawn only to what is left.
 * A short chapter steps up to a darker neutral and takes an underline across its
 * foot: text hue on the left half, audio hue on the right, each half drawn only
 * when that medium is actually short. Two halves rather than one blended line,
 * for the same reason `PlanBar` draws two adjacent segments — a composite of the
 * two hues is a third colour belonging to neither.
 */
function PlanTile({
  section, label, ariaSubject, wide = false, showAudio, showCount, selected, onSelect,
}: {
  section: PlanSection
  /** What the tile prints: the chapter number, or the whole key off the grid. */
  label: string
  /** What the aria-label names this tile by. */
  ariaSubject: string
  /** Off the numbered grid, where a key like "Scene 4" needs room to be read. */
  wide?: boolean
  showAudio: boolean
  showCount: boolean
  selected: boolean
  onSelect: (key: string) => void
}) {
  const t = useT()
  const { textShort, audioShort, worst } = tileFacts(section, showAudio)
  const complete = worst === 0
  // A numbered chapter names itself as one; anything off the numbered grid —
  // front matter, a one-chapter book, a document's own section — names itself
  // by its key instead. Announcing "Chapter Scene 4" would invent a chapter
  // that does not exist, to the one reader who cannot see that it is not on the
  // grid with the others.
  const aria = wide
    ? t("org.projectOverview.plan.tileAriaSection", { section: ariaSubject, short: worst })
    : t("org.projectOverview.plan.tileAria", { chapter: ariaSubject, short: worst })

  return (
    <button
      type="button"
      data-testid={`plan-tile-${section.key}`}
      data-short={complete ? undefined : "true"}
      aria-pressed={selected}
      aria-label={aria}
      title={aria}
      onClick={() => onSelect(section.key)}
      className={`relative flex items-center justify-center overflow-hidden rounded-[3px] pb-[3px] text-[10px] leading-none font-medium tabular-nums transition-colors ${
        wide ? "h-6 px-1.5" : "aspect-square"
      } ${
        complete
          ? "bg-muted text-muted-foreground hover:bg-muted/70"
          : "bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30"
      } ${selected ? "ring-2 ring-primary" : ""}`}
    >
      {label}
      {showCount && !complete && (
        <span
          data-testid={`plan-tile-badge-${section.key}`}
          className="absolute end-[1px] top-[1px] rounded-[2px] bg-card/85 px-[1.5px] text-[7.5px] leading-[1.35] font-semibold text-foreground"
        >
          {worst}
        </span>
      )}
      {!complete && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[3px]">
          <span
            data-plan-underline="text"
            className="flex-1"
            style={{
              backgroundColor: textShort > 0
                ? hexToRgba(HUE.text, underlineAlpha(textShort, section.totalCount))
                : "transparent",
            }}
          />
          <span
            data-plan-underline="audio"
            className="flex-1"
            style={{
              backgroundColor: audioShort > 0
                ? hexToRgba(HUE.audio, underlineAlpha(audioShort, section.totalCount))
                : "transparent",
            }}
          />
        </span>
      )}
    </button>
  )
}
