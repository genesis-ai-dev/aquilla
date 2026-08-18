/**
 * Style-rule library section on the Living Memory → Translation quality pane
 * (AQU-934 phase 2).
 *
 * Composes the review queue, the approved-rule library, the per-rule
 * applicability editor and the knowledge-base extraction dialog over a single
 * `useStyleRules` instance, so one refetch after a mutation refreshes all of
 * them.
 *
 * Role floors (live-resolved from the project's syncRole, like the rest of the
 * page): proposing/extracting needs CONTRIBUTOR (400); reviewing, editing,
 * enabling and applicability writes need PROJECT_LEAD (500) — the same floors
 * the server enforces. The extract action is hidden below its floor with a
 * `RoleLockTooltip` beside the heading (matching the sibling Standards
 * section); row-level controls stay visible but disabled so the state they
 * carry is still readable.
 */

import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useStyleRules } from "@/hooks/useStyleRules"
import { ROLE } from "@/lib/frontier/roles"
import {
  listKnowledgeDocuments,
  type KnowledgeDocument,
  type KnowledgeScope,
} from "@/lib/frontier/knowledge-base"
import type { FrontierSession } from "@/lib/frontier/types"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { CompletionSettings } from "@/lib/parsers/types"
import type {
  StyleRule,
  StyleRuleCategory,
  StyleRuleScope,
} from "@/lib/rules/style-rule-types"
import { RoleLockTooltip } from "./AuthoredEntriesSection"
import { ExtractRulesDialog } from "./ExtractRulesDialog"
import { RuleApplicabilityDialog } from "./RuleApplicabilityDialog"
import { StyleRuleCandidates } from "./StyleRuleCandidates"
import { StyleRuleLibrary, type StyleRuleLabels } from "./StyleRuleLibrary"

/** Library grouping order — broad vocabulary first, catch-all last. */
const CATEGORY_ORDER: readonly StyleRuleCategory[] = [
  "terminology",
  "register",
  "formatting",
  "grammar",
  "orthography",
  "style",
  "other",
]

const CATEGORY_LABEL_KEY: Record<StyleRuleCategory, MessageKey> = {
  terminology: "terminology.livingMemory.styleRules.category.terminology",
  register: "terminology.livingMemory.styleRules.category.register",
  formatting: "terminology.livingMemory.styleRules.category.formatting",
  grammar: "terminology.livingMemory.styleRules.category.grammar",
  orthography: "terminology.livingMemory.styleRules.category.orthography",
  style: "terminology.livingMemory.styleRules.category.style",
  other: "terminology.livingMemory.styleRules.category.other",
}

const SCOPE_LABEL_KEY: Record<StyleRuleScope, MessageKey> = {
  global: "terminology.livingMemory.styleRules.scope.global",
  genre: "terminology.livingMemory.styleRules.scope.genre",
  document: "terminology.livingMemory.styleRules.scope.document",
  section: "terminology.livingMemory.styleRules.scope.section",
  passage: "terminology.livingMemory.styleRules.scope.passage",
  segment: "terminology.livingMemory.styleRules.scope.segment",
}

const SEVERITY_LABEL_KEY: Record<StyleRule["severity"], MessageKey> = {
  major: "rules.severity.major",
  minor: "rules.severity.minor",
}

interface QualityStyleRulesProps {
  projectId: string
  roleLevel: number | null
  completionSettings?: CompletionSettings
  session: FrontierSession | null
}

export function QualityStyleRules({
  projectId,
  roleLevel,
  completionSettings,
  session,
}: QualityStyleRulesProps) {
  const t = useT()
  const { locale } = useI18n()
  const {
    rules,
    applicability,
    error,
    refresh,
    createRule,
    updateRule,
    review,
    setApplicability,
    removeApplicability,
  } = useStyleRules(projectId)

  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [extractOpen, setExtractOpen] = useState(false)
  const [applicabilityRule, setApplicabilityRule] = useState<StyleRule | null>(null)

  const jwt = session?.jwt ?? null
  const scope: KnowledgeScope = useMemo(
    () => ({ kind: "project", id: projectId }),
    [projectId],
  )

  // Knowledge docs feed BOTH the extraction picker and the source citations on
  // proposed rules, so they are fetched once here rather than per dialog.
  useEffect(() => {
    if (!jwt) return
    let live = true
    void listKnowledgeDocuments(scope, jwt)
      .then((loaded) => { if (live) setDocs(loaded) })
      .catch(() => { if (live) setDocs([]) })
    return () => { live = false }
  }, [jwt, scope])

  const docNames = useMemo(
    () => Object.fromEntries(docs.map((doc) => [doc.id, doc.name])),
    [docs],
  )

  // One resolved vocabulary for both lists — the queue's chips and the
  // library's group headings can't drift apart.
  const labels = useMemo<StyleRuleLabels>(
    () => ({
      categoryOrder: CATEGORY_ORDER,
      category: Object.fromEntries(
        CATEGORY_ORDER.map((c) => [c, t(CATEGORY_LABEL_KEY[c])]),
      ) as Record<StyleRuleCategory, string>,
      scope: Object.fromEntries(
        (Object.keys(SCOPE_LABEL_KEY) as StyleRuleScope[]).map((s) => [s, t(SCOPE_LABEL_KEY[s])]),
      ) as Record<StyleRuleScope, string>,
      severity: { major: t(SEVERITY_LABEL_KEY.major), minor: t(SEVERITY_LABEL_KEY.minor) },
    }),
    [t],
  )

  const canPropose = roleLevel != null && roleLevel >= ROLE.CONTRIBUTOR
  const canReview = roleLevel != null && roleLevel >= ROLE.PROJECT_LEAD

  const candidates = rules.filter((rule) => rule.status === "proposed")
  const library = rules.filter((rule) => rule.status === "approved")
  const openRows = applicabilityRule
    ? applicability.filter((row) => row.ruleId === applicabilityRule.id)
    : []

  return (
    <section aria-label={t("terminology.livingMemory.styleRules.title")}>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 text-xs font-semibold text-muted-foreground">
          {t("terminology.livingMemory.styleRules.title")}
        </h2>
        {canPropose ? (
          <Button
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => setExtractOpen(true)}
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {t("terminology.livingMemory.styleRules.extract.button")}
          </Button>
        ) : (
          <RoleLockTooltip reason="role" requiredRole="contributor" />
        )}
      </div>

      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t("terminology.livingMemory.styleRules.description")}
      </p>

      {error ? (
        <div
          className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t("terminology.livingMemory.styleRules.loadError", { message: error })}</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t("terminology.livingMemory.styleRules.candidates.heading")}
            </h3>
            {candidates.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {t("terminology.livingMemory.styleRules.candidates.pendingCount", {
                  count: formatCount(candidates.length, locale),
                })}
              </Badge>
            ) : null}
            <div className="flex-1" />
            {canReview ? null : <RoleLockTooltip reason="role" requiredRole="projectLead" />}
          </div>
          <StyleRuleCandidates
            rules={candidates}
            canReview={canReview}
            labels={labels}
            docNames={docNames}
            onReview={(id, action) => { void review(id, action) }}
            onSave={(id, patch) => { void updateRule(id, patch) }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {t("terminology.livingMemory.styleRules.library.heading")}
          </h3>
          <StyleRuleLibrary
            rules={library}
            canManage={canReview}
            labels={labels}
            onToggleEnabled={(rule, enabled) => { void updateRule(rule.id, { enabled }) }}
            onOpenApplicability={setApplicabilityRule}
          />
        </div>
      </div>

      <RuleApplicabilityDialog
        rule={applicabilityRule}
        rows={openRows}
        canManage={canReview}
        onClose={() => setApplicabilityRule(null)}
        onAdd={(row) => {
          if (applicabilityRule) void setApplicability(applicabilityRule.id, row)
        }}
        onRemove={(applicabilityId) => {
          if (applicabilityRule) void removeApplicability(applicabilityRule.id, applicabilityId)
        }}
      />

      <ExtractRulesDialog
        open={extractOpen}
        onOpenChange={setExtractOpen}
        scope={scope}
        jwt={jwt}
        docs={docs}
        settings={completionSettings}
        session={session}
        onCreate={createRule}
        onFinished={() => { void refresh() }}
      />
    </section>
  )
}
