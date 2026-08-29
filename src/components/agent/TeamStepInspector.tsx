/**
 * TeamStepInspector.tsx — the optional third column of the Team surface
 * (v2.2 three-column layout, 2026-08-28): detail for one step of a thread.
 * The thread stays plain language; this pane holds the receipts — the
 * durable event behind the sentence, the situation note, the outcome
 * reasons — collapsed by default but one click from inspectable.
 *
 * The column is user-resizable (v3 live-review fix, 2026-08-28: "should be
 * wider… or at least draggable"). The width lives here rather than in the
 * parent layout so the third column owns its own chrome: a pointer drag on
 * the inline-start edge, arrow keys for a keyboard, and the result persisted
 * per browser. Sizing is in logical terms — the app is RTL-aware, so the
 * handle sits at `inset-inline-start` and the pointer delta is read against
 * the computed direction, not against a hard-coded "left".
 */

import { ChevronRight, GripVertical, X } from "lucide-react"
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import { PersonaAvatar } from "./PersonaAvatar"

/** Per-browser, not per-project: this is a chrome preference, like a sidebar
 *  width — it should not follow a project or a run around. */
const WIDTH_STORAGE_KEY = "aquilla:team-step-inspector-width"
const DEFAULT_WIDTH = 320
const MIN_WIDTH = 260
const MAX_WIDTH = 560
/** One arrow press. Coarse enough to be worth pressing, fine enough to land. */
const KEYBOARD_STEP = 16

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY)
    if (raw === null) return DEFAULT_WIDTH
    return clampWidth(Number.parseInt(raw, 10))
  } catch {
    // Storage can be absent (SSR/tests) or blocked (private mode). A missing
    // preference is not an error — fall back to the default width.
    return DEFAULT_WIDTH
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
  } catch {
    // A full or blocked store must not break resizing for this session.
  }
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-1 py-1 text-start text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0", open && "rotate-90")} />
        {title}
      </button>
      {open && <div className="ps-4 pt-0.5">{children}</div>}
    </div>
  )
}

export interface TeamStepInspectorProps {
  message: TeamFeedMessage
  /** Plain-language sentence for the step (rendered by the thread's own
   *  formatter so the two panes never disagree). */
  sentence: string
  onClose: () => void
}

export function TeamStepInspector({ message, sentence, onClose }: TeamStepInspectorProps) {
  const { locale, t } = useI18n()
  const persona = AGENT_PERSONAS[message.persona]
  const time = message.at
    ? new Date(message.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : null
  const excerpt = message.body.kind === "sceneReady" ? message.body.excerpt : null
  const reasons = message.body.kind === "outcome" ? message.body.reasons : []
  const detailEntries = Object.entries(message.raw.details)

  const [width, setWidth] = useState(readStoredWidth)
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)

  /** Single writer for the width so state and the drag-time ref never drift. */
  function applyWidth(next: number): number {
    const clamped = clampWidth(next)
    widthRef.current = clamped
    setWidth(clamped)
    return clamped
  }

  /**
   * +1 when growing the column means moving the handle toward larger clientX.
   * The handle is on the column's INLINE-START edge: in LTR that is its left
   * edge (drag left → wider, so a positive delta shrinks); under `dir="rtl"`
   * the layout mirrors and the same edge sits on the right, flipping the sign.
   * Read the direction in effect rather than assuming the document's.
   */
  function widenSign(element: Element): number {
    return getComputedStyle(element).direction === "rtl" ? 1 : -1
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = widthRef.current
    const sign = widenSign(handle)
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an optimization (it keeps the drag alive outside
      // the 6px strip), not a requirement — happy-dom does not implement it.
    }
    setDragging(true)

    const onMove = (moveEvent: PointerEvent) => {
      applyWidth(startWidth + sign * (moveEvent.clientX - startX))
    }
    const onUp = (upEvent: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      try {
        handle.releasePointerCapture(upEvent.pointerId)
      } catch {
        // Already released, or never captured.
      }
      setDragging(false)
      writeStoredWidth(widthRef.current)
    }
    // On the handle, not the window: pointer capture retargets the move here,
    // and unmounting mid-drag takes the listeners with the element.
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const towardEnd = event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP
    writeStoredWidth(applyWidth(widthRef.current + widenSign(event.currentTarget) * towardEnd))
  }

  return (
    <div
      className="relative flex shrink-0 flex-col border-s border-border/60"
      style={{ width }}
      data-testid="team-step-inspector"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("agent.team.inspector.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        data-testid="team-step-inspector-resize"
        data-dragging={dragging ? "" : undefined}
        className={cn(
          "group/step-resize absolute inset-y-0 start-0 z-20 flex w-1.5 cursor-col-resize touch-none",
          "items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
      >
        <GripVertical
          aria-hidden
          className={cn(
            "pointer-events-none h-4 w-4 text-muted-foreground opacity-0 transition-opacity",
            "group-hover/step-resize:opacity-100 group-focus-visible/step-resize:opacity-100",
            dragging && "opacity-100",
          )}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("agent.team.inspector.title")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          onClick={onClose}
          aria-label={t("agent.team.inspector.close")}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-start gap-2">
            <PersonaAvatar personaId={persona.id} className="mt-0.5" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-foreground">{t(persona.nameKey)}</span>
                {time && <span className="text-[10px] text-muted-foreground">{time}</span>}
              </div>
              <p className="text-sm leading-relaxed">{sentence}</p>
            </div>
          </div>

          {excerpt && (
            <InspectorSection title={t("agent.team.inspector.note")}>
              <p className="text-xs leading-relaxed text-muted-foreground">{excerpt}</p>
            </InspectorSection>
          )}

          {reasons.length > 0 && (
            <InspectorSection title={t("agent.team.inspector.reasons")}>
              {/* Outcome reasons come off the wire as machine tokens
                  ("span_failed", "no_source_text"), never as authored copy.
                  Muted mono types them as diagnostic codes so a reader sees a
                  code they can quote, not a sentence that came out broken. */}
              <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                {reasons.map((reason) => (
                  <li key={reason} className="break-words font-mono">
                    {reason}
                  </li>
                ))}
              </ul>
            </InspectorSection>
          )}

          <InspectorSection title={t("agent.team.inspector.details")}>
            <dl className="flex flex-col gap-1 text-[11px]">
              <div className="flex gap-2">
                <dt className="shrink-0 font-mono text-muted-foreground">
                  {/* i18n-exempt machine field name, not copy */}
                  kind
                </dt>
                <dd className="min-w-0 break-words font-mono">{message.raw.kind}</dd>
              </div>
              {detailEntries.length === 0 ? (
                <p className="text-muted-foreground">{t("agent.team.inspector.noDetails")}</p>
              ) : (
                detailEntries.map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
                    <dd className="min-w-0 break-words font-mono">
                      {typeof value === "string" ? value : JSON.stringify(value)}
                    </dd>
                  </div>
                ))
              )}
            </dl>
          </InspectorSection>
        </div>
      </ScrollArea>
    </div>
  )
}
