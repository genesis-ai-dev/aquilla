/**
 * RunChecks — a run's Checks tab (PR threads spec §4): every pending draft
 * with verifier findings, "Needs you" first, each linking to its card in Files
 * changed. Reads the same useRunReview data the header counts come from.
 */

import { Link } from "react-router-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useT } from "@/lib/i18n/I18nProvider"
import { agentConversationHref } from "@/lib/agent/workspace-location"
import { runThreadId } from "@/lib/agent/team-channel"
import type { ContextualDraftRecord, ContextualRunRecord } from "@/lib/contextual/transport"
import type { RunReview } from "@/hooks/useRunReview"
import { DraftFindingChips } from "./DraftFindingChips"

export function draftReviewHref(projectId: string, runId: string, cellId: string): string {
  return `${agentConversationHref(projectId, runThreadId(runId), "review")}&cell=${encodeURIComponent(cellId)}`
}

function CheckRow({ draft, projectId, runId }: { draft: ContextualDraftRecord; projectId: string; runId: string }) {
  const t = useT()
  const where = draft.spanLabel ? `${draft.spanLabel} · ${draft.cellId}` : draft.cellId
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2">
      <Link
        to={draftReviewHref(projectId, runId, draft.cellId)}
        aria-label={t("agent.pr.checks.open", { ref: where })}
        className="truncate text-sm font-medium underline-offset-2 hover:underline"
      >
        {where}
      </Link>
      <p className="line-clamp-2 text-xs text-muted-foreground" dir="auto">{draft.text}</p>
      <DraftFindingChips review={draft.review} evidence />
    </li>
  )
}

export function RunChecks({ projectId, run, review }: { projectId: string; run: ContextualRunRecord; review: RunReview }) {
  const t = useT()
  const flagged = review.drafts
    .filter((d) => (d.review?.findings.length ?? 0) > 0)
    .sort((a, b) => (b.review?.severity ?? 0) - (a.review?.severity ?? 0))
  const needsYou = flagged.filter((d) => d.review?.triage === "human")
  const advisory = flagged.filter((d) => d.review?.triage !== "human")

  const section = (title: string, drafts: ContextualDraftRecord[], testId: string) =>
    drafts.length > 0 && (
      <section className="flex flex-col gap-2" data-testid={testId}>
        <h3 className="text-sm font-semibold">{title} · {drafts.length}</h3>
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => <CheckRow key={d.draftId} draft={d} projectId={projectId} runId={run.runId} />)}
        </ul>
      </section>
    )

  return (
    <ScrollArea className="min-h-0 flex-1" data-testid="run-checks">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4">
        {review.loading && review.drafts.length === 0 ? (
          <div role="status" aria-label={t("agent.pr.checks.loading")} className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : flagged.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agent.pr.checks.empty")}</p>
        ) : (
          <>
            {section(t("agent.pr.checks.needsYou"), needsYou, "checks-needs-you")}
            {section(t("agent.pr.checks.advisory"), advisory, "checks-advisory")}
          </>
        )}
      </div>
    </ScrollArea>
  )
}
