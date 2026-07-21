/**
 * BriefPanel.tsx — the project brief view/edit surface + its proposals
 * sub-list (AQU-AGENT contracts §3/§5, owner W1E).
 *
 * The brief is deliberately "high-oversight: human approval only" (§3: PUT
 * and proposal review both 403 on the agent channel) — this panel frames
 * that explicitly rather than presenting it as a normal editable field.
 * PUT carries `ifMatchVersion`; a 409 means someone else changed the brief
 * first, so the edit is discarded and the caller must reload before retrying
 * (no silent overwrite).
 */

import { useState } from "react"
import { AlertTriangle, Pencil, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { ROLE } from "@/lib/agent/role-floors"
import { VersionConflictError, type ProjectBrief, type ProjectBriefProposal } from "@/lib/agent/memory-api"

export interface BriefPanelProps {
  brief: ProjectBrief | null
  proposals: ProjectBriefProposal[]
  roleLevel: number | null
  busyProposalIds: Set<string>
  onSaveBrief: (content: string, ifMatchVersion: number) => Promise<void>
  onReloadBrief: () => void
  onApproveProposal: (proposal: ProjectBriefProposal) => void
  onRejectProposal: (proposal: ProjectBriefProposal) => void
}

function canEditBrief(roleLevel: number | null): boolean {
  return roleLevel == null || roleLevel >= ROLE.PROJECT_LEAD
}

export function BriefPanel({
  brief,
  proposals,
  roleLevel,
  busyProposalIds,
  onSaveBrief,
  onReloadBrief,
  onApproveProposal,
  onRejectProposal,
}: BriefPanelProps) {
  const [editOpen, setEditOpen] = useState(false)

  if (!brief) {
    return <p className="px-1 py-4 text-xs text-muted-foreground">Loading project brief…</p>
  }

  const allowed = canEditBrief(roleLevel)
  const pendingProposals = proposals.filter((p) => p.status === "proposed")

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border bg-card px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">Project brief</span>
            <span className="text-[10px] text-muted-foreground">v{brief.version}</span>
          </div>
          {allowed ? (
            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => setEditOpen(true)}>
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <ShieldAlert className="h-3 w-3" />
              Project lead only
            </span>
          )}
        </div>
        {brief.content.trim() ? (
          <div className="rounded-md border bg-background/60 px-2 py-1.5 text-xs">
            <ChatMarkdown content={brief.content} />
          </div>
        ) : (
          <p className="text-xs italic text-muted-foreground">No brief written yet.</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="h-3 w-3" />
          Brief proposals — high-oversight: human approval only.
        </p>
        {pendingProposals.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No pending brief proposals.</p>
        ) : (
          <div className="space-y-2">
            {pendingProposals.map((proposal) => {
              const busy = busyProposalIds.has(proposal.id)
              return (
                <div key={proposal.id} className="space-y-2 rounded-lg border bg-card px-2.5 py-2">
                  <div className="rounded-md border bg-background/60 px-2 py-1.5 text-xs">
                    <ChatMarkdown content={proposal.content} />
                  </div>
                  {proposal.rationale && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">Rationale: </span>
                      {proposal.rationale}
                    </p>
                  )}
                  {allowed ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px]"
                        disabled={busy}
                        onClick={() => onRejectProposal(proposal)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 text-[11px]"
                        disabled={busy}
                        onClick={() => onApproveProposal(proposal)}
                      >
                        {busy && <Spinner data-icon="inline-start" />}
                        Approve
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                      <ShieldAlert className="h-3 w-3" />
                      Requires project lead or higher to review
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {editOpen && (
        <EditBriefDialog
          brief={brief}
          onClose={() => setEditOpen(false)}
          onSave={onSaveBrief}
          onReload={onReloadBrief}
        />
      )}
    </div>
  )
}

function EditBriefDialog({
  brief,
  onClose,
  onSave,
  onReload,
}: {
  brief: ProjectBrief
  onClose: () => void
  onSave: (content: string, ifMatchVersion: number) => Promise<void>
  onReload: () => void
}) {
  const [content, setContent] = useState(brief.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  async function doSave() {
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      await onSave(content, brief.version)
      onClose()
    } catch (err) {
      if (err instanceof VersionConflictError) {
        setConflict(true)
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Failed to save brief.")
      }
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project brief</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-48 font-mono text-xs"
            aria-label="Brief content"
            disabled={conflict}
          />
          {error && <FieldError role="alert">{error}</FieldError>}
          {conflict && (
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload latest brief
            </Button>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => setConfirmOverwrite(true)}
            disabled={busy || conflict || content === brief.content}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>

      {confirmOverwrite && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmOverwrite(false)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Overwrite the project brief?</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm">
                This replaces the brief every agent run reads as ground truth. Continue?
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOverwrite(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setConfirmOverwrite(false)
                  void doSave()
                }}
              >
                Overwrite
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  )
}
