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
  /** Select the cue on the timeline and scroll both sides into view. */
  onNavigate(cueCellId: string): void
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
  const cue = cueById.get(row.cueCellId)
  const text = textById.get(row.textCellId)
  return (
    <div
      data-testid={`cue-link-candidate-${row.cueCellId}`}
      className="rounded-md border border-border p-2 text-xs"
    >
      <button
        type="button"
        className="flex w-full flex-col gap-1 text-left"
        onClick={() => onNavigate(row.cueCellId)}
      >
        <div className="flex items-baseline gap-2">
          <TimeLabel cue={cue} />
          <span className="text-muted-foreground">heard</span>
          <span className="min-w-0 flex-1 truncate">{clip(cue?.original)}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <TimeLabel cue={text} />
          <span className="text-muted-foreground">line</span>
          <span className="min-w-0 flex-1 truncate">{clip(text?.original)}</span>
        </div>
      </button>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          data-testid={`cue-link-pair-${row.cueCellId}`}
          onClick={() => onPair(row.textCellId, row.cueCellId)}
        >
          <Check className="mr-1 h-3 w-3" /> Pair
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`cue-link-reject-${row.cueCellId}`}
          onClick={() => onReject(row.textCellId, row.cueCellId)}
        >
          Not a pair
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
  const cue = cueById.get(pair.cueCellId)
  const text = textById.get(pair.textCellId)
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <button
        type="button"
        data-testid={`cue-link-pair-row-${pair.cueCellId}`}
        className="flex w-full flex-col gap-1 text-left"
        onClick={() => onNavigate(pair.cueCellId)}
      >
        <div className="truncate">{clip(cue?.original)}</div>
        <div className="truncate text-muted-foreground">{clip(text?.original)}</div>
      </button>
      <button
        type="button"
        className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => onReject(pair.textCellId, pair.cueCellId)}
      >
        Not a pair
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
  onPair,
  onReject,
  onRepairAll,
}: Props) {
  const [confirmingRepair, setConfirmingRepair] = useState(false)
  const rowProps = { textById, cueById, onNavigate, onPair, onReject }

  return (
    <aside
      data-testid="cue-link-drawer"
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-background"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Link2 className="h-4 w-4 text-violet-600 dark:text-violet-400" />
        <span className="text-sm font-medium">Pairings</span>
        {pending ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3" /> working…
          </span>
        ) : (
          review && (
            <span data-testid="cue-link-actionable" className="text-xs text-muted-foreground">
              {review.actionable === 0 ? "nothing to review" : `${review.actionable} to review`}
            </span>
          )
        )}
        <Button size="sm" variant="ghost" className="ml-auto" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* Its natural home: this is where you are when you decide the pairings
            need redoing. It used to be reachable only by re-picking a VTT you
            had already imported, which is a button wearing an import dialog. */}
        {confirmingRepair ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs">
            <p>
              Work out every pairing again from scratch? This discards any pairing you fixed by
              hand.
            </p>
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
                Re-pair everything
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmingRepair(false)}>
                Cancel
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
            <RefreshCw className="mr-1 h-3 w-3" /> Re-pair everything
          </Button>
        )}

        {review && (
          <>
            {review.confident.length > 0 && (
              <Section
                title="Almost certainly the same line"
                hint="Identical wording, moments apart, in a gap the pairings left open."
              >
                {review.confident.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.uncertain.length > 0 && (
              <Section
                title="The only candidate nearby"
                hint="Nothing else is unpaired between them, but the words don't agree."
              >
                {review.uncertain.map((row) => (
                  <CandidateRow key={row.cueCellId} row={row} {...rowProps} />
                ))}
              </Section>
            )}

            {review.crossScript.length > 0 && (
              <Section
                title="Paired on timing alone"
                hint="Different writing systems, so nothing compared the words."
              >
                {review.crossScript.map((p) => (
                  <PairRow key={p.cueCellId} pair={p} {...rowProps} />
                ))}
              </Section>
            )}

            {review.lowConfidence.length > 0 && (
              <Section title="Paired, but barely" hint="Weak wording agreement. Probably fine.">
                {review.lowConfidence.map((p) => (
                  <PairRow key={p.cueCellId} pair={p} {...rowProps} />
                ))}
              </Section>
            )}

            <div className="mt-auto border-t border-border pt-2">
              <CollapsedGroup
                testId="cue-link-orphan-cues"
                label={(n) => `${n} heard line${n === 1 ? "" : "s"} with no subtitle nearby`}
                ids={review.unpairedCues}
                byId={cueById}
                onNavigate={onNavigate}
              />
              <CollapsedGroup
                testId="cue-link-orphan-text"
                label={(n) => `${n} line${n === 1 ? "" : "s"} with no speech nearby`}
                ids={review.unpairedText}
                byId={textById}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
