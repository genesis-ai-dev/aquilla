/**
 * ProposedMemoryList.tsx — the "Proposed" review queue for agent-authored
 * memories (AQU-AGENT contracts §3/§5, owner W1E).
 *
 * Each card shows path, a markdown-rendered content preview, rationale, and
 * provenance (run/session id), with Approve / Reject actions. Approve/Reject
 * require PROJECT_LEAD+ server-side (§3) — the buttons hide below that floor
 * when roleLevel is known, mirroring role-floors.ts's fail-open posture
 * (unknown role never blocks). A confirming dialog gates Reject since it's
 * destructive-ish (the row leaves the queue for good in the common flow).
 */

import { useState } from "react"
import { ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { ROLE } from "@/lib/agent/role-floors"
import type { AgentMemory } from "@/lib/agent/memory-api"

export interface ProposedMemoryListProps {
  memories: AgentMemory[]
  roleLevel: number | null
  busyIds: Set<string>
  onApprove: (memory: AgentMemory) => void
  onReject: (memory: AgentMemory) => void
}

function canReview(roleLevel: number | null): boolean {
  return roleLevel == null || roleLevel >= ROLE.PROJECT_LEAD
}

export function ProposedMemoryList({
  memories,
  roleLevel,
  busyIds,
  onApprove,
  onReject,
}: ProposedMemoryListProps) {
  const t = useT()
  const [rejectTarget, setRejectTarget] = useState<AgentMemory | null>(null)

  if (memories.length === 0) {
    return (
      <p className="px-1 py-4 text-xs text-muted-foreground">
        {t("agent.memory.noneProposed")}
      </p>
    )
  }

  const allowed = canReview(roleLevel)

  return (
    <div className="space-y-2">
      {memories.map((memory) => {
        const busy = busyIds.has(memory.id)
        return (
          <div
            key={memory.id}
            data-memory-path={memory.path}
            className="space-y-2 rounded-lg border bg-card px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <code className="min-w-0 truncate text-xs font-medium">{memory.path}</code>
              {memory.provenance?.runId && (
                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                  {t("agent.memory.provenanceRun", { runId: memory.provenance.runId })}
                </Badge>
              )}
              {memory.provenance?.sessionId && (
                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                  {t("agent.memory.provenanceSession", { sessionId: memory.provenance.sessionId })}
                </Badge>
              )}
            </div>

            <div className="rounded-md border bg-background/60 px-2 py-1.5 text-xs">
              <ChatMarkdown content={memory.content} />
            </div>

            {memory.rationale && (
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{t("agent.memory.rationaleLabel")} </span>
                {memory.rationale}
              </p>
            )}

            {allowed ? (
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  variant="ghost"
                  className="h-6 text-[11px]"
                  disabled={busy}
                  onClick={() => setRejectTarget(memory)}
                >
                  {t("agent.reject")}
                </Button>
                <Button
                  className="h-6 text-[11px]"
                  disabled={busy}
                  onClick={() => onApprove(memory)}
                >
                  {busy && <Spinner data-icon="inline-start" />}
                  {t("agent.approve")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                <ShieldAlert className="h-3 w-3" />
                {t("agent.memory.requiresLeadNotice")}
              </div>
            )}
          </div>
        )
      })}

      {rejectTarget && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setRejectTarget(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("agent.memory.rejectConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-2">
              <p className="text-sm">
                <RichMessage
                  k="agent.memory.rejectConfirmBody"
                  values={{ path: <code>{rejectTarget.path}</code> }}
                />
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRejectTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  onReject(rejectTarget)
                  setRejectTarget(null)
                }}
              >
                {t("agent.reject")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
