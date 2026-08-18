/**
 * CharacterCheckDrawer — where the two character sheets disagree, and where
 * you settle it. (AQU-646, 2026-08-18)
 *
 * Deliberately the same shape and visual language as CueLinkDrawer — Section
 * headings, bordered rows that navigate on click, actions that stop the click
 * from also navigating — because the two sit in the same slot and are the same
 * kind of surface: a findings list a person works down.
 *
 * WHY IT CAN ACT AT ALL. The two sheets are independent opinions about the same
 * question, so a disagreement means a wrong link, a wrong sheet, or one name
 * typed two ways. No rule decides between them — the audio sheet is not simply
 * better ("I'm on official business." is Nicodemus; the audio sheet says
 * Quintus and is wrong). Only a person can say, so the buttons are the two
 * candidate ANSWERS, labelled with the values themselves. A sticky two-column
 * header names the sides once — Subtitle left, Audio right, ALWAYS — instead of
 * a paragraph you must remember for eighty rows.
 *
 * THE BUTTON PASSES THE VALUE IT SHOWS. The first cut let the workspace
 * re-derive both values from the live cells at click time, which is wrong the
 * moment a pair has been resolved: both cells then hold the winner, so a
 * re-click recorded "rejected: NICODEMUS" over the real QUINTUS — destroying
 * the one copy of the losing answer — and a flip would have re-written the
 * winner while claiming to change the choice. The drawer is the only party
 * that knows both candidates in every state (open rows from the cells,
 * resolved rows from the record), so what it displays is what gets written.
 *
 * NOTHING EVER DROPS OUT. A settled row moves to Resolved: out of the way,
 * still showing what was set aside, still flippable — and re-clicking the
 * side already chosen is a no-op, not a re-write.
 */

import { useState } from "react"
import { Check, ChevronRight, Users, X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  CharacterAgreement,
  CharacterDisagreement,
  ResolvedRow,
} from "@/lib/timeline/character-agreement"
import type { CameraState } from "@/lib/sync/cells-read-types"

/** Which sheet an answer came from. */
export type Side = "subtitle" | "audio"
export type Axis = "name" | "camera"

/** What a click means: this exact value wins, that exact value is set aside.
 *  Carried FROM the button so the write can never diverge from the label. */
export interface ResolveChoice {
  textCellId: string
  cueCellId: string
  axis: Axis
  side: Side
  /** The value on the clicked button. */
  value: string
  /** The value on the other button — what the record keeps. */
  rejected: string
}

interface Props {
  agreement: CharacterAgreement | null
  /** Both sheets have to be in before there is a second opinion to differ. */
  bothSheetsImported: boolean
  onClose(): void
  /** Show the line in context — cue on the timeline, row in the table. */
  onNavigate(cueCellId: string, textCellIds?: readonly string[]): void
  onResolve(choices: readonly ResolveChoice[]): void
  /** Undo EVERY decision: each rejected value goes back where it came from and
   *  every disagreement returns to the open list. */
  onResetAll(): void
  /**
   * A character write is in flight. Set ⇒ the drawer is INERT.
   *
   * Not decoration: a bulk resolve queues ~150 events one at a time, and while
   * it ran the list used to reshuffle under the cursor as rows migrated to
   * Resolved — so a click landed on a different row than the one aimed at. The
   * list is frozen upstream; this is what says so and stops the buttons.
   */
  pending?: { done: number; total: number; phase: "writing" | "syncing" } | null
}

const cameraWord = (s: CameraState): string =>
  s === "on" ? "on camera" : s === "off" ? "off camera" : "mixed"

/**
 * One decision: the two candidate answers, subtitle LEFT, audio RIGHT, always —
 * the sticky header up top is what names the columns, so the positions must
 * never shuffle under it.
 */
function Choice({
  subtitle,
  audio,
  chosen,
  onPick,
  testId,
  disabled,
}: {
  subtitle: string
  audio: string
  /** Set once settled; the chosen side re-clicks as a no-op. */
  chosen?: Side
  onPick(side: Side): void
  testId: string
  disabled?: boolean
}) {
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-1.5" onClick={(e) => e.stopPropagation()}>
      {(["subtitle", "audio"] as const).map((side) => (
        <button
          key={side}
          type="button"
          data-testid={`${testId}-${side}`}
          aria-pressed={chosen === side}
          disabled={disabled}
          onClick={() => {
            // Re-affirming the side already believed writes nothing — the
            // Quintus bug was precisely a re-click being treated as news.
            if (chosen !== side) onPick(side)
          }}
          className={cn(
            "min-w-0 truncate rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
            disabled && "cursor-default",
            chosen === side
              ? "border-emerald-500/60 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
              : chosen !== undefined
                ? "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                : "border-border hover:bg-accent",
          )}
        >
          {side === "subtitle" ? subtitle : audio}
        </button>
      ))}
    </div>
  )
}

/** The rows are cards that navigate, like CueLinkDrawer's — the whole card is
 *  the target, and the buttons stop the click from also navigating. */
function RowShell({
  onOpen,
  heard,
  context,
  muted,
  inert,
  children,
  testId,
}: {
  onOpen(): void
  heard: string
  /** The undisputed facts about this line, as one short string. */
  context?: string
  muted?: boolean
  /** Mid-write: the list is frozen, so navigating would take you somewhere on
   *  the strength of a row that is about to change. */
  inert?: boolean
  children: React.ReactNode
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      role="button"
      tabIndex={inert ? -1 : 0}
      aria-disabled={inert || undefined}
      onClick={() => { if (!inert) onOpen() }}
      onKeyDown={(e) => {
        if (inert) return
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        onOpen()
      }}
      className={cn(
        "rounded-md border border-border p-2 text-xs transition-colors",
        inert ? "cursor-default" : "cursor-pointer hover:bg-muted/40",
        muted && "border-border/60 bg-muted/20",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn("min-w-0 flex-1 truncate italic", muted ? "text-muted-foreground" : "text-foreground/90")}>
          {heard ? `“${heard}”` : "—"}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 self-center text-muted-foreground" />
      </div>
      {context && (
        // What the sheets AGREE on. A speaker dispute showing the agreed
        // camera angle — or a camera dispute showing the agreed name — turns
        // "click the card and look at the film" into a quick check of who the
        // picture is actually on. (Sam, 2026-08-18.)
        <p data-testid="character-check-context" className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {context}
        </p>
      )}
      {children}
    </div>
  )
}

function OpenRowCard({
  row,
  onNavigate,
  onResolve,
  inert,
}: {
  row: CharacterDisagreement
  onNavigate: Props["onNavigate"]
  onResolve: Props["onResolve"]
  inert?: boolean
}) {
  const pick = (axis: Axis, side: Side) => {
    const pair =
      axis === "name"
        ? { subtitle: row.name!.subtitle, audio: row.name!.audio }
        : { subtitle: cameraWord(row.camera!.subtitle), audio: cameraWord(row.camera!.audio) }
    const raw =
      axis === "name"
        ? pair
        : { subtitle: row.camera!.subtitle, audio: row.camera!.audio }
    onResolve([
      {
        textCellId: row.textCellId,
        cueCellId: row.cueCellId,
        axis,
        side,
        value: String(raw[side]),
        rejected: String(raw[side === "subtitle" ? "audio" : "subtitle"]),
      },
    ])
  }
  return (
    <RowShell
      testId="character-check-row"
      inert={inert}
      heard={row.heard}
      context={[
        row.context?.name,
        row.context?.camera ? cameraWord(row.context.camera) : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
      onOpen={() => onNavigate(row.cueCellId, [row.textCellId])}
    >
      {row.name && (
        <Choice
          subtitle={row.name.subtitle}
          audio={row.name.audio}
          onPick={(side) => pick("name", side)}
          testId="character-check-name"
          disabled={inert}
        />
      )}
      {row.camera && (
        <Choice
          subtitle={cameraWord(row.camera.subtitle)}
          audio={cameraWord(row.camera.audio)}
          onPick={(side) => pick("camera", side)}
          testId="character-check-camera"
          disabled={inert}
        />
      )}
      {/* Half-decided rows say so, or they look untouched. */}
      {row.settled?.name && !row.name && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Speaker settled — {row.settled.name.rejected} was set aside.
        </p>
      )}
      {row.settled?.camera && !row.camera && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Camera settled — {cameraWord(row.settled.camera.rejected)} was set aside.
        </p>
      )}
    </RowShell>
  )
}

function ResolvedRowCard({
  row,
  onNavigate,
  onResolve,
  inert,
}: {
  row: ResolvedRow
  onNavigate: Props["onNavigate"]
  onResolve: Props["onResolve"]
  inert?: boolean
}) {
  /** The two candidates as they stood at decision time, rebuilt from the
   *  record — the cells both hold the winner now and know nothing else. */
  const flip = (axis: Axis, side: Side) => {
    const a = axis === "name" ? row.name! : row.camera!
    const values = {
      [a.chose]: String(a.current),
      [a.chose === "subtitle" ? "audio" : "subtitle"]: String(a.rejected),
    } as Record<Side, string>
    onResolve([
      {
        textCellId: row.textCellId,
        cueCellId: row.cueCellId,
        axis,
        side,
        value: values[side],
        rejected: values[side === "subtitle" ? "audio" : "subtitle"],
      },
    ])
  }
  return (
    <RowShell
      testId="character-check-resolved-row"
      inert={inert}
      heard={row.heard}
      muted
      onOpen={() => onNavigate(row.cueCellId, [row.textCellId])}
    >
      {/* Same two buttons, same two positions, chosen one marked — changing
          your mind is the same gesture as making it. */}
      {row.name && (
        <Choice
          subtitle={row.name.chose === "subtitle" ? row.name.current : row.name.rejected}
          audio={row.name.chose === "audio" ? row.name.current : row.name.rejected}
          chosen={row.name.chose}
          onPick={(side) => flip("name", side)}
          testId="character-check-resolved-name"
          disabled={inert}
        />
      )}
      {row.camera && (
        <Choice
          subtitle={cameraWord(row.camera.chose === "subtitle" ? row.camera.current : row.camera.rejected)}
          audio={cameraWord(row.camera.chose === "audio" ? row.camera.current : row.camera.rejected)}
          chosen={row.camera.chose}
          onPick={(side) => flip("camera", side)}
          testId="character-check-resolved-camera"
          disabled={inert}
        />
      )}
    </RowShell>
  )
}

/** CueLinkDrawer's Section, verbatim shape. */
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

export function CharacterCheckDrawer({
  agreement,
  bothSheetsImported,
  onClose,
  onNavigate,
  onResolve,
  onResetAll,
  pending,
}: Props) {
  const [showResolved, setShowResolved] = useState(false)
  /** Which bulk decision is awaiting its "are you sure". */
  const [confirmingBulk, setConfirmingBulk] = useState<Side | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const open = agreement?.open ?? []
  const resolved = agreement?.resolved ?? []
  // Grouped by the PRIMARY axis so a row appears exactly once: a line that
  // disagrees about both sits under the speaker section carrying its camera
  // buttons with it.
  const nameRows = open.filter((r) => r.name)
  const cameraRows = open.filter((r) => r.camera && !r.name)
  const allCameraRows = open.filter((r) => r.camera)

  /** Bulk: one decision, applied having looked — never an import policy. */
  const resolveAllCameras = (side: Side) =>
    onResolve(
      allCameraRows.map((r) => ({
        textCellId: r.textCellId,
        cueCellId: r.cueCellId,
        axis: "camera" as const,
        side,
        value: String(r.camera![side]),
        rejected: String(r.camera![side === "subtitle" ? "audio" : "subtitle"]),
      })),
    )

  return (
    <aside
      data-testid="character-check-drawer"
      className="flex h-full min-w-0 max-w-80 shrink basis-80 flex-col overflow-hidden border-l bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Users className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium">Characters</span>
        {pending ? (
          // DETERMINATE on purpose: 150 writes is long enough that a bare
          // spinner reads as hung.
          <span
            data-testid="character-check-pending"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Spinner className="h-3 w-3" />
            {pending.phase === "syncing"
              ? "Syncing…"
              : `Saving… ${pending.done} of ${pending.total}`}
          </span>
        ) : (
          <span data-testid="character-check-count" className="text-xs text-muted-foreground">
            {open.length === 0 ? "nothing to check" : `${open.length} to check`}
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* The columns, named ONCE and always in view — not a paragraph you have
          to remember for eighty rows. "Subtitle" and "Audio" are the import
          buttons' own words. Picking either writes it to both cells, so
          nothing is left on screen showing the answer you set aside. */}
      {bothSheetsImported && (
        <div
          data-testid="character-check-columns"
          className="grid grid-cols-2 gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
        >
          <span>Subtitle</span>
          <span>Audio</span>
        </div>
      )}

      {/* SCROLLING STAYS LIVE — the wheel targets this container, and only its
          contents go inert, so nobody is trapped in a drawer for ten seconds.
          Close is in the header above, outside this region. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3"
        aria-busy={pending ? true : undefined}
      >
        <div className={cn("flex flex-col gap-4", pending && "opacity-50")}>
        {!bothSheetsImported ? (
          // An explanation, not a disabled menu item — a greyed-out control
          // says nothing about why.
          <p data-testid="character-check-one-sheet" className="text-xs text-muted-foreground">
            Both character sheets have to be imported before there is anything to check. Each is
            keyed to one side of the script — one row per subtitle line, one per heard line — and
            comparing them is what turns up a wrong pairing or a wrong sheet.
          </p>
        ) : (
          <>
            {nameRows.length > 0 && (
              <Section
                title={`Who says it · ${nameRows.length}`}
                hint="The sheets name different people. Either the pairing is wrong or one sheet is."
              >
                <div data-testid="character-check-names" className="flex flex-col gap-1.5">
                  {nameRows.map((r) => (
                    <OpenRowCard
                      key={`${r.cueCellId}:${r.textCellId}`}
                      row={r}
                      onNavigate={onNavigate}
                      onResolve={onResolve}
                      inert={Boolean(pending)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {cameraRows.length > 0 && (
              <Section
                title={`Camera · ${cameraRows.length}`}
                hint="Same person; the sheets disagree about whether the camera is on them."
              >
                {/* Bulk stays ONE ROW — short labels, the sticky header
                    carries the meaning. (Sam, 2026-08-18: the long labels
                    pushed the drawer off the right edge of the screen.) */}
                {allCameraRows.length > 3 &&
                  (confirmingBulk ? (
                    // The "are you sure" — same inline shape as the pairing
                    // drawer's repair-all confirm. A sweep of eighty
                    // judgements deserves a second look before it lands, even
                    // though every one stays flippable afterwards.
                    <div
                      data-testid="character-check-bulk-confirm"
                      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
                    >
                      <p>
                        Use the {confirmingBulk} sheet's camera answer for all{" "}
                        {allCameraRows.length} lines? Each lands in Resolved and can still be
                        flipped one by one.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          data-testid="character-check-bulk-go"
                          disabled={Boolean(pending)}
                          onClick={() => {
                            const side = confirmingBulk
                            setConfirmingBulk(null)
                            resolveAllCameras(side)
                          }}
                        >
                          Use {confirmingBulk}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirmingBulk(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">All {allCameraRows.length}:</span>
                      {(["subtitle", "audio"] as const).map((side) => (
                        <Button
                          key={side}
                          size="sm"
                          variant="outline"
                          className="h-6 min-w-0 text-[10px]"
                          data-testid={`character-check-bulk-${side}`}
                          disabled={Boolean(pending)}
                          onClick={() => setConfirmingBulk(side)}
                        >
                          {side === "subtitle" ? "Subtitle" : "Audio"}
                        </Button>
                      ))}
                    </div>
                  ))}
                <div data-testid="character-check-cameras" className="flex flex-col gap-1.5">
                  {cameraRows.map((r) => (
                    <OpenRowCard
                      key={`${r.cueCellId}:${r.textCellId}`}
                      row={r}
                      onNavigate={onNavigate}
                      onResolve={onResolve}
                      inert={Boolean(pending)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {open.length === 0 && (
              <p data-testid="character-check-clear" className="text-xs text-muted-foreground">
                The two sheets agree everywhere they both have something to say.
              </p>
            )}

            {/* A fact rather than a job: one subtitle row covering several
                heard lines cannot have one right answer, and the per-line
                display is already correct. */}
            {agreement != null && agreement.sharedRows > 0 && (
              <p data-testid="character-check-shared" className="text-[11px] text-muted-foreground">
                {agreement.sharedRows} pairings sit on a subtitle row that covers several heard
                lines, so one name cannot describe them all. Nothing to fix.
              </p>
            )}

            {resolved.length > 0 && (
              <section data-testid="character-check-resolved">
                <button
                  type="button"
                  className="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  data-testid="character-check-resolved-toggle"
                  onClick={() => setShowResolved((v) => !v)}
                >
                  <Check className="h-3.5 w-3.5" />
                  Resolved · {resolved.length}
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", showResolved && "rotate-90")}
                  />
                </button>
                {showResolved && (
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {resolved.map((r) => (
                      <ResolvedRowCard
                        key={`${r.cueCellId}:${r.textCellId}`}
                        row={r}
                        onNavigate={onNavigate}
                        onResolve={onResolve}
                        inert={Boolean(pending)}
                      />
                    ))}
                  </div>
                )}

                {/* THE WAY ALL THE WAY BACK. Every rejected value returns to
                    the cell it came from and every disagreement reopens —
                    the mirror of the bulk button, so a sweep taken in error
                    is one click (and one "are you sure") from undone. */}
                {confirmingReset ? (
                  <div
                    data-testid="character-check-reset-confirm"
                    className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs"
                  >
                    <p>
                      Un-resolve all {resolved.length}? Every disagreement returns to the list
                      with both answers restored. Nothing is deleted from the sheets.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        data-testid="character-check-reset-go"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          setConfirmingReset(false)
                          onResetAll()
                        }}
                      >
                        Un-resolve everything
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmingReset(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full text-xs text-muted-foreground"
                    data-testid="character-check-reset"
                    disabled={Boolean(pending)}
                    onClick={() => setConfirmingReset(true)}
                  >
                    Un-resolve everything
                  </Button>
                )}
              </section>
            )}
          </>
        )}
        </div>
      </div>
    </aside>
  )
}
