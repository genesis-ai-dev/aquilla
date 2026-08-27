/**
 * CueLinkDrawer — the pairing review list. (AQU-646 stage 4)
 *
 * Opened by the timeline's "Link cues" button, which also turns linking mode
 * on, so the drawer being open IS the mode rather than two states that can
 * disagree. Deliberately the same right-hand shape as CheckFindingsDrawer: a
 * list of findings whose rows navigate, which is a pattern this app already
 * has and people already read.
 *
 * WHY A LIST AT ALL, when the timeline already marks unpaired cells amber. The
 * chips tell you WHERE and nothing about whether it matters — 28 amber cells on
 * episode 101, of which two are real misses and the rest are fine. Scanning
 * them is not a job with an end. This is: it ranks by a hole in the alignment
 * (see `cue-link-review.ts`), which on the real episode leaves about five rows
 * and two counts.
 *
 * The groups are separate rather than one ranked list on purpose. "Same words,
 * half a second apart" and "the only candidate nearby, but the words disagree"
 * rest on the same evidence and deserve completely different amounts of
 * thought; ranking them on one axis would put them three pixels apart and imply
 * they are the same kind of decision.
 */

import { useState } from "react"
import { Check, ChevronRight, Link2, RefreshCw, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { fmtClock } from "./format"
import type { CueLinkReview, ReviewCandidate, ReviewPair } from "@/lib/timeline/cue-link-review"
import type { LinkableCue } from "@/lib/timeline/cue-links"

interface Props {
  review: CueLinkReview | null
  /** The matcher is writing pairings right now. */
  pending?: boolean
  textById: ReadonlyMap<string, LinkableCue>
  cueById: ReadonlyMap<string, LinkableCue>
  onClose(): void
  /**
   * Show this pairing in context: the cue on the timeline, and the subtitle
   * line(s) in the dialogue table.
   *
   * `textCellIds` is passed for a PROPOSED pairing, where the two are not
   * linked yet — without it the workspace would follow the cue's links, find
   * none, and clear the selection, which is exactly the "nothing happens" a
   * candidate row used to produce.
   */
  onNavigate(cueCellId: string, textCellIds?: readonly string[]): void
  /** Show an unpaired SUBTITLE line: its own row in the table, and its place on
   *  the timeline. Separate from `onNavigate` because it is not a cue and has
   *  no pairing to follow. */
  onNavigateText(textCellId: string): void
  onPair(textCellId: string, cueCellId: string): void
  onReject(textCellId: string, cueCellId: string): void
  /** Re-derive every pairing. Discards hand corrections, hence the confirm. */
  onRepairAll(): void
}

const clip = (s: string | undefined, n = 70): string =>
  !s ? "—" : s.length > n ? `${s.slice(0, n)}…` : s

function TimeLabel({ cue }: { cue: LinkableCue | undefined }) {
  if (!cue || typeof cue.startTime !== "number") return null
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {fmtClock(cue.startTime, true)}
    </span>
  )
}

/** A proposed pairing: both lines, and the two answers. */
function CandidateRow({
  row,
  textById,
  cueById,
  onNavigate,
  onPair,
  onReject,
}: {
  row: ReviewCandidate
} & Pick<Props, "textById" | "cueById" | "onNavigate" | "onPair" | "onReject">) {
  const t = useT()
  const cue = cueById.get(row.cueCellId)
  const text = textById.get(row.textCellId)
  return (
    <div
      data-testid={`cue-link-candidate-${row.cueCellId}`}
      role="button"
      tabIndex={0}
      // The whole card is the target — clicking the padding beside the words
      // did nothing, which reads as a dead row. Both ids go over, because the
      // pairing does not exist yet and the links cannot answer for it.
      onClick={() => onNavigate(row.cueCellId, [row.textCellId])}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        onNavigate(row.cueCellId, [row.textCellId])
      }}
      className="cursor-pointer rounded-md border border-border p-2 text-xs transition-colors hover:bg-muted/40"
    >
      <div className="flex w-full flex-col gap-1 text-left">
        <div className="flex items-baseline gap-2">
          <TimeLabel cue={cue} />
          <span className="text-muted-foreground">{t("editor.timeline.cueLinkHeard")}</span>
          <span className="min-w-0 flex-1 truncate">{clip(cue?.original)}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <TimeLabel cue={text} />
          <span className="text-muted-foreground">{t("editor.timeline.cueLinkLine")}</span>
          <span className="min-w-0 flex-1 truncate">{clip(text?.original)}</span>
        </div>
      </div>
      {/* The actions must not also navigate — a click that both pairs and
          scrolls would make the list jump under the pointer as it shortens. */}
      <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          data-testid={`cue-link-pair-${row.cueCellId}`}
          onClick={() => onPair(row.textCellId, row.cueCellId)}
        >
          <Check className="mr-1 h-3 w-3" /> {t("editor.timeline.cueLinkPair")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`cue-link-reject-${row.cueCellId}`}
          onClick={() => onReject(row.textCellId, row.cueCellId)}
        >
          {t("editor.timeline.cueLinkNotAPair")}
        </Button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {Math.round(row.similarity * 100)}% · {row.gapSec.toFixed(1)}s
        </span>
      </div>
    </div>
  )
}

function PairRow({
  pair,
  textById,
  cueById,
  onNavigate,
  onReject,
}: { pair: ReviewPair } & Pick<Props, "textById" | "cueById" | "onNavigate" | "onReject">) {
  const t = useT()
  const cue = cueById.get(pair.cueCellId)
  const text = textById.get(pair.textCellId)
  return (
    <div
      data-testid={`cue-link-pair-row-${pair.cueCellId}`}
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(pair.cueCellId, [pair.textCellId])}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        onNavigate(pair.cueCellId, [pair.textCellId])
      }}
      className="cursor-pointer rounded-md border border-border p-2 text-xs transition-colors hover:bg-muted/40"
    >
      <div className="flex w-full flex-col gap-1 text-left">
        <div className="truncate">{clip(cue?.original)}</div>
        <div className="truncate text-muted-foreground">{clip(text?.original)}</div>
      </div>
      <button
        type="button"
        className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          onReject(pair.textCellId, pair.cueCellId)
        }}
      >
        {t("editor.timeline.cueLinkNotAPair")}
      </button>
    </div>
  )
}

/** A count that opens. The hopeless cases are worth stating and not worth
 *  competing with the rows you can act on. */
function CollapsedGroup({
  testId,
  label,
  ids,
  byId,
  onNavigate,
}: {
  testId: string
  label: (n: number) => string
  ids: readonly string[]
  byId: ReadonlyMap<string, LinkableCue>
  onNavigate?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  return (
    <div className="text-xs">
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-1 py-1 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        {label(ids.length)}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 pl-4">
          {ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                className="flex w-full gap-2 text-left hover:underline"
                onClick={() => onNavigate?.(id)}
              >
                <TimeLabel cue={byId.get(id)} />
                <span className="min-w-0 flex-1 truncate">{clip(byId.get(id)?.original, 50)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-xs font-medium">{title}</h3>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function CueLinkDrawer({
  review,
  pending = false,
  textById,
  cueById,
  onClose,
  onNavigate,
  onNavigateText,
  onPair,
  onReject,
  onRepairAll,
}: Props) {
  const t = useT()
  const [confirmingRepair, setConfirmingRepair] = useState(false)
  const rowProps = { textById, cueById, onNavigate, onPair, onReject }

  return (
    <aside
      data-testid="cue-link-drawer"
      // Matches CheckFindingsDrawer exactly: a flex sibling inside the content
      // box, NOT a fixed overlay. Sam, 2026-08-15 — above this box live the
      // file tabs, the breadcrumbs and the import button, and a drawer has no
      // business covering any of them.
      className="flex h-full min-w-0 max-w-80 shrink basis-80 flex-col overflow-hidden border-l bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Link2 className="h-4 w-4 text-violet-600 dark:text-violet-400" />
        <span className="text-sm font-medium">{t("editor.timeline.cueLinkTitle")}</span>
        {pending ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3" /> {t("editor.timeline.cueLinkWorking")}
          </span>
        ) : (
          review && (
            <span data-testid="cue-link-actionable" className="text-xs text-muted-foreground">
              {review.actionable === 0
                ? t("editor.timeline.cueLinkNothingToReview")
                : t("editor.timeline.cueLinkToReview", { count: review.actionable })}
            </span>
          )
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* SAYS THE MODE IS ON. (Sam, 2026-08-18.) Opening this drawer also arms
          linking — one state, deliberately — but it is now reached from a menu
          item, which reads like "show me a list" rather than "put me in a
          mode". A line here is present exactly while the mode is, which a
          toast cannot be; the confusing state was one where nothing on screen
          said which way it was set. */}
      <p
        data-testid="cue-link-mode-note"
        className="border-b border-border bg-violet-50 px-3 py-1.5 text-[11px] text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
      >
        {t("editor.timeline.cueLinkModeNote")}
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* Its natural home: this is where you are when you decide the pairings
            need redoing. It used to be reachable only by re-picking a VTT you
            had already imported, which is a button wearing an import dialog. */}
        {confirmingRepair ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs">
            <p>{t("editor.timeline.cueLinkRepairConfirm")}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                data-testid="cue-link-repair-go"
                onClick={() => {
                  setConfirmingRepair(false)
                  onRepairAll()
                }}
              >
                {t("editor.timeline.cueLinkRepairAll")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmingRepair(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            data-testid="cue-link-repair"
            disabled={pending}
            onClick={() => setConfirmingRepair(true)}
          >
            <RefreshCw className="mr-1 h-3 w-3" /> {t("editor.timeline.cueLinkRepairAll")}
          </Button>
        )}

        {review && (
          <>
            {review.confident.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkConfidentTitle")}
                hint={t("editor.timeline.cueLinkConfidentHint")}
              >
                {review.confident.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.crossScriptCandidates.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkCrossScriptCandidatesTitle")}
                hint={t("editor.timeline.cueLinkCrossScriptCandidatesHint")}
              >
                {review.crossScriptCandidates.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.weakCandidates.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkWeakTitle")}
                hint={t("editor.timeline.cueLinkWeakHint")}
              >
                {review.weakCandidates.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.uncertain.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkUncertainTitle")}
                hint={t("editor.timeline.cueLinkUncertainHint")}
              >
                {review.uncertain.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.crossScript.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkCrossScriptTitle")}
                hint={t("editor.timeline.cueLinkCrossScriptHint")}
              >
                {review.crossScript.map((p) => (
                  <PairRow key={p.cueCellId} pair={p} {...rowProps} />
                ))}
              </Section>
            )}

            {review.lowConfidence.length > 0 && (
              <Section
                title={t("editor.timeline.cueLinkLowConfidenceTitle")}
                hint={t("editor.timeline.cueLinkLowConfidenceHint")}
              >
                {review.lowConfidence.map((p) => (
                  <PairRow key={p.cueCellId} pair={p} {...rowProps} />
                ))}
              </Section>
            )}

            <div className="mt-auto border-t border-border pt-2">
              <CollapsedGroup
                testId="cue-link-orphan-cues"
                label={(n) => t("editor.timeline.cueLinkOrphanCues", { count: n })}
                ids={review.unpairedCues}
                byId={cueById}
                onNavigate={(id) => onNavigate(id)}
              />
              <CollapsedGroup
                testId="cue-link-orphan-text"
                label={(n) => t("editor.timeline.cueLinkOrphanText", { count: n })}
                ids={review.unpairedText}
                byId={textById}
                // A SUBTITLE, not a cue — it has a row of its own to scroll to,
                // and the timeline can seat its chip directly.
                onNavigate={onNavigateText}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
