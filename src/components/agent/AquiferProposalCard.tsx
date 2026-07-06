/**
 * AquiferProposalCard.tsx — agent proposal to publish a Bible Aquifer answer.
 *
 * One card per `aquifer_proposal` SSE frame. Unlike ProposalCard, Apply does
 * NOT go through the events outbox — it POSTs to the Bible Aquifer wiki via
 * aquiferPublishAnswer (src/lib/aquifer/client.ts). On success the returned
 * wiki URL is shown. Kept deliberately minimal and consistent with ProposalCard.
 */

import { useState } from "react"
import { Book, Check, ExternalLink, Loader2 } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { AquiferPublishProposal } from "@/lib/agent/protocol"
import { aquiferPublishAnswer } from "@/lib/aquifer/client"

const TRUNCATE_AT = 280

export interface AquiferProposalCardProps {
  proposal: AquiferPublishProposal
  projectId: string
  /** Frontier session JWT; null = not signed in (Apply disabled). */
  jwt: string | null
}

type CardState = "idle" | "applying" | "applied" | "discarded"

export function AquiferProposalCard({ proposal, projectId, jwt }: AquiferProposalCardProps) {
  const [state, setState] = useState<CardState>("idle")
  const [applyError, setApplyError] = useState<string | null>(null)
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const answer = proposal.answer
  const needsTruncation = answer.length > TRUNCATE_AT
  const shownAnswer = expanded || !needsTruncation ? answer : `${answer.slice(0, TRUNCATE_AT)}…`

  async function handleApply() {
    if (state !== "idle" || !jwt) return
    setState("applying")
    setApplyError(null)
    try {
      const { url } = await aquiferPublishAnswer(jwt, projectId, {
        question: proposal.question,
        answer: proposal.answer,
        status: proposal.status,
        citations: proposal.citations,
      })
      setPublishedUrl(url)
      setState("applied")
    } catch (err) {
      setState("idle")
      setApplyError(err instanceof Error ? err.message : String(err))
    }
  }

  if (state === "discarded") {
    return (
      <div className="rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground">
        Discarded: {proposal.question}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Book className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{proposal.question}</span>
        <Badge
          variant={proposal.status === "answered" ? "secondary" : "outline"}
          className="px-1.5 py-0 text-[10px]"
        >
          {proposal.status}
        </Badge>
      </div>

      <div className="text-xs">
        {shownAnswer}
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 inline-flex items-center align-baseline text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {proposal.citations.length > 0 && (
        <div className="space-y-0.5">
          {proposal.citations.map((c, i) => (
            <AppTooltip key={`${proposal.proposalId}-cite-${i}`} content={c.url}>
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{c.title || c.url}</span>
              </a>
            </AppTooltip>
          ))}
        </div>
      )}

      {applyError && (
        <div className="text-[11px] text-destructive">Publish failed: {applyError}</div>
      )}

      {state === "applied" ? (
        <div className="space-y-1 text-[11px] font-medium text-emerald-600">
          <div className="flex items-center gap-1">
            <Check className="h-3 w-3" /> Published
          </div>
          {publishedUrl && (
            <AppTooltip content={publishedUrl}>
              <a
                href={publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate font-normal text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{publishedUrl}</span>
              </a>
            </AppTooltip>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => setState("discarded")}
            disabled={state === "applying"}
          >
            Discard
          </Button>
          <Button
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void handleApply()}
            disabled={!jwt || state === "applying"}
            title={!jwt ? "Sign in to publish" : undefined}
          >
            {state === "applying" ? (
              <>
                <Loader2 className={cn("h-3 w-3 animate-spin")} /> Publishing…
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
