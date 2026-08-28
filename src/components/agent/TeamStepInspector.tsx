/**
 * TeamStepInspector.tsx — the optional third column of the Team surface
 * (v2.2 three-column layout, 2026-08-28): detail for one step of a thread.
 * The thread stays plain language; this pane holds the receipts — the
 * durable event behind the sentence, the situation note, the outcome
 * reasons — collapsed by default but one click from inspectable.
 */

import { ChevronRight, X } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import { PersonaAvatar } from "./PersonaAvatar"

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
  return (
    <div
      className="flex w-72 shrink-0 flex-col border-s border-border/60"
      data-testid="team-step-inspector"
    >
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
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
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
