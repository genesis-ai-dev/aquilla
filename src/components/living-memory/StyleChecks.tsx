/**
 * Style rules as checks (AQU-934; AQU-2342: one Checks list).
 *
 * Owns the style-rule data — one `useStyleRules` instance, so one refetch after
 * a mutation refreshes everything — and the dialogs that edit it: where a rule
 * applies, the AI refine of that, and extraction from knowledge documents.
 * It does NOT render a list of its own: approved style rules are rows of the
 * unified Checks list, so this hands the list a `StyleChecksBinding` through
 * its render prop. The review queue (proposed rules) and the document-genre
 * block (genre assignment is what makes a genre-scoped rule reach a document)
 * come back as nodes the list places.
 *
 * Role floors (live-resolved from the project's syncRole, like the rest of the
 * page): proposing/extracting needs CONTRIBUTOR (400); reviewing, editing,
 * enabling and applicability writes need PROJECT_LEAD (500) — the same floors
 * the server enforces.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
  RuleApplicability,
  StyleRule,
  StyleRuleCategory,
  StyleRuleScope,
} from "@/lib/rules/style-rule-types"
import { suggestFileGenres } from "@/lib/rules/file-genre"
import { RoleLockTooltip } from "./RoleLockTooltip"
import { DocumentGenres, type GenreFile } from "./DocumentGenres"
import { ExtractRulesDialog } from "./ExtractRulesDialog"
import { RefineApplicabilityDialog, type RefineSegment } from "./RefineApplicabilityDialog"
import { RuleApplicabilityDialog } from "./RuleApplicabilityDialog"
import { StyleRuleCandidates } from "./StyleRuleCandidates"
import type { StyleRuleLabels } from "./style-rule-labels"

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

/** What the unified Checks list needs from the style-rule store. */
export interface StyleChecksBinding {
  rules: StyleRule[]
  applicability: RuleApplicability[]
  /** PROJECT_LEAD+: toggle, edit where a rule applies, refine, review. */
  canManage: boolean
  labels: StyleRuleLabels
  toggle: (rule: StyleRule, enabled: boolean) => void
  openApplicability: (rule: StyleRule) => void
  /** Absent without a model or a segment source. */
  refine?: (rule: StyleRule) => void
  /** Open extraction from knowledge documents; absent below CONTRIBUTOR. */
  extract?: () => void
  /** Proposed rules awaiting review, or null when there are none. */
  reviewQueue: ReactNode
  /** Genre assignment for documents, or null when not wired. */
  documentGenres: ReactNode
  /** Load failure banner, or null. */
  errorBanner: ReactNode
}

interface StyleChecksProps {
  projectId: string
  roleLevel: number | null
  completionSettings?: CompletionSettings
  session: FrontierSession | null
  /** Document-genre block inputs, from the page's own settings instance. */
  files?: readonly GenreFile[]
  fileGenres?: Record<string, string>
  canEditSettings?: boolean
  reasonCannotEditSettings?: "offline" | "role" | null
  patchFileGenres?: (partial: { fileGenres: Record<string, string> }) => Promise<unknown>
  /** Segment source for AI applicability refinement (phase 3c). */
  loadSegments?: (fileId: string | null, signal: AbortSignal) => Promise<readonly RefineSegment[]>
  children: (binding: StyleChecksBinding) => ReactNode
}

export function StyleChecks({
  projectId,
  roleLevel,
  completionSettings,
  session,
  files,
  fileGenres,
  canEditSettings = false,
  reasonCannotEditSettings = "role",
  patchFileGenres,
  loadSegments,
  children,
}: StyleChecksProps) {
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
  const [refineRule, setRefineRule] = useState<StyleRule | null>(null)

  const jwt = session?.jwt ?? null
  const scope: KnowledgeScope = useMemo(() => ({ kind: "project", id: projectId }), [projectId])

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

  const docNames = useMemo(() => Object.fromEntries(docs.map((doc) => [doc.id, doc.name])), [docs])

  const labels = useMemo<StyleRuleLabels>(
    () => ({
      categoryOrder: CATEGORY_ORDER,
      category: Object.fromEntries(
        CATEGORY_ORDER.map((c) => [c, t(CATEGORY_LABEL_KEY[c])]),
      ) as Record<StyleRuleCategory, string>,
      scope: Object.fromEntries(
        (Object.keys(SCOPE_LABEL_KEY) as StyleRuleScope[]).map((s) => [s, t(SCOPE_LABEL_KEY[s])]),
      ) as Record<StyleRuleScope, string>,
      severity: { major: t("rules.severity.major"), minor: t("rules.severity.minor") },
    }),
    [t],
  )

  const canPropose = roleLevel != null && roleLevel >= ROLE.CONTRIBUTOR
  const canReview = roleLevel != null && roleLevel >= ROLE.PROJECT_LEAD

  const suggestGenres = useMemo(() => {
    if (!completionSettings) return undefined
    return (batch: readonly GenreFile[]) =>
      suggestFileGenres({
        files: batch.map((file) => ({ fileId: file.id, name: file.name, sample: file.sample ?? "" })),
        settings: completionSettings,
        session,
      })
  }, [completionSettings, session])

  const candidates = rules.filter((rule) => rule.status === "proposed")
  const openRows = applicabilityRule ? applicability.filter((row) => row.ruleId === applicabilityRule.id) : []

  const reviewQueue = candidates.length === 0 ? null : (
    <section aria-label={t("terminology.livingMemory.styleRules.candidates.heading")} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t("terminology.livingMemory.styleRules.candidates.heading")}
        </h3>
        <Badge variant="secondary" className="tabular-nums">
          {t("terminology.livingMemory.styleRules.candidates.pendingCount", {
            count: formatCount(candidates.length, locale),
          })}
        </Badge>
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
    </section>
  )

  const documentGenres = files && patchFileGenres ? (
    <DocumentGenres
      files={files}
      assignments={fileGenres}
      canEdit={canEditSettings}
      reasonCannotEdit={reasonCannotEditSettings}
      onSave={(next) => patchFileGenres({ fileGenres: next })}
      onSuggest={suggestGenres}
    />
  ) : null

  const errorBanner = error ? (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t("terminology.livingMemory.styleRules.loadError", { message: error })}</span>
    </div>
  ) : null

  const binding: StyleChecksBinding = {
    rules,
    applicability,
    canManage: canReview,
    labels,
    toggle: (rule, enabled) => { void updateRule(rule.id, { enabled }) },
    openApplicability: setApplicabilityRule,
    ...(loadSegments && completionSettings ? { refine: setRefineRule } : {}),
    ...(canPropose ? { extract: () => setExtractOpen(true) } : {}),
    reviewQueue,
    documentGenres,
    errorBanner,
  }

  return (
    <>
      {children(binding)}

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

      <RefineApplicabilityDialog
        rule={refineRule}
        files={files ?? []}
        loadSegments={loadSegments}
        rows={applicability}
        settings={completionSettings}
        session={session}
        canManage={canReview}
        onClose={() => setRefineRule(null)}
        onConfirm={(confirmed) => {
          const rule = refineRule
          if (!rule) return
          // Sequential on purpose: every row lands through the same upsert the
          // manual editor uses, and each one refetches the library.
          void (async () => {
            for (const row of confirmed) await setApplicability(rule.id, row)
          })()
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
    </>
  )
}
