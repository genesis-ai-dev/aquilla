// src/components/brief/BriefSection.tsx
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { BriefStatus, TranslationBrief } from "@/lib/brief/types"
import { briefStatus } from "@/lib/brief/brief"

export interface BriefSectionProps {
  brief: TranslationBrief | undefined
  canEdit: boolean
  stale: boolean
  onEdit: () => void
  onGenerate: () => void
  /** True while an L1 generation is in flight — locks edit/generate so a
   *  concurrent open-and-save can't clobber the brief mid-regenerate. */
  busy?: boolean
}

/** Localized badge text per derived status — never the raw enum value. */
const STATUS_LABEL_KEY = {
  none: "terminology.livingMemory.section.brief.statusNone",
  draft: "terminology.livingMemory.section.brief.statusDraft",
  complete: "terminology.livingMemory.section.brief.statusComplete",
} as const satisfies Record<BriefStatus, MessageKey>

/** What each status means for the AI — see the explainer note below. */
const STATUS_EXPLAINER_KEY = {
  none: "terminology.livingMemory.section.brief.statusNoneExplainer",
  draft: "terminology.livingMemory.section.brief.statusDraftExplainer",
  complete: "terminology.livingMemory.section.brief.statusCompleteExplainer",
} as const satisfies Record<BriefStatus, MessageKey>

export function BriefSection(props: BriefSectionProps) {
  const t = useT()
  const { brief, canEdit, stale, onEdit, onGenerate, busy = false } = props
  const status = briefStatus(brief)

  return (
    <section aria-label={t("autopilot.readiness.brief.label")}>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">{t("autopilot.readiness.brief.label")}</h2>
        {/* AQU-1672: the raw enum rendered untranslated ("draft") and said
            nothing about what the state meant. */}
        <Badge variant="secondary" className="text-[10px]">{t(STATUS_LABEL_KEY[status])}</Badge>
        {/* AQU-912: two partner users read the brief as required and as the same
            thing as the AI instructions. The qualifier sits where the decision is
            made — the empty state, before anyone has invested in a brief. Reuses
            the shared "(optional)" note rather than adding a fourth phrasing. */}
        {status === "none" && (
          <span className="text-[10px] text-muted-foreground">{t("common.optionalFieldNote")}</span>
        )}
        {brief && stale && <Badge variant="outline" className="text-[10px]">{t("agent.brief.summaryOutOfDate")}</Badge>}
      </div>

      {status === "none" ? (
        <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
          <p className="mb-3">
            {t("agent.brief.capturePurpose")}
          </p>
          <p className="mb-3 text-xs">{t(STATUS_EXPLAINER_KEY[status])}</p>
          {canEdit && <Button onClick={onEdit} disabled={busy}>{t("agent.brief.createBrief")}</Button>}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 p-4 space-y-3">
          {/* AQU-1672: the status is derived and there is nothing to approve, so
              the card says in words whether this brief is in force and what
              would move it to Complete, instead of leaving a permanent "Draft"
              badge reading as a blocked step. */}
          <p className="text-xs text-muted-foreground">{t(STATUS_EXPLAINER_KEY[status])}</p>
          {brief?.l1Summary ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{brief.l1Summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("agent.brief.noSummaryYet")}</p>
          )}
          {canEdit && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onEdit} disabled={busy}>{t("agent.brief.editBrief")}</Button>
              <Button variant={stale ? "default" : "ghost"} onClick={onGenerate} disabled={busy}>
                {busy ? "Generating…" : brief?.l1Summary ? "Regenerate summary" : "Generate summary"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
