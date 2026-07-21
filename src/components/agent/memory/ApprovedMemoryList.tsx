/**
 * ApprovedMemoryList.tsx — path-grouped list of approved agent memories with
 * inline view + Edit (PATCH) (AQU-AGENT contracts §3/§5, owner W1E).
 *
 * A human edit sets `humanEdited=true` server-side; once set, the agent
 * channel's PATCH gets a 403 `human_edit_protected` (§3) — this list shows a
 * shield badge on those rows so the human reviewer knows the row is now
 * agent-write-protected ("it can only ask").
 */

import { useState } from "react"
import { Pencil, ShieldCheck } from "lucide-react"
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
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { AppTooltip } from "@/components/ui/tooltip"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { ROLE } from "@/lib/agent/role-floors"
import type { AgentMemory } from "@/lib/agent/memory-api"

export interface ApprovedMemoryListProps {
  memories: AgentMemory[]
  roleLevel: number | null
  username: string | null
  onEdit: (memory: AgentMemory, content: string) => Promise<void>
}

function canEdit(memory: AgentMemory, roleLevel: number | null, username: string | null): boolean {
  if (roleLevel == null) return true // unknown role: fail open, server is authoritative
  if (roleLevel >= ROLE.PROJECT_LEAD) return true
  return roleLevel >= ROLE.CONTRIBUTOR && username != null && memory.createdBy === username
}

export function ApprovedMemoryList({ memories, roleLevel, username, onEdit }: ApprovedMemoryListProps) {
  const [editing, setEditing] = useState<AgentMemory | null>(null)

  if (memories.length === 0) {
    return <p className="px-1 py-4 text-xs text-muted-foreground">No approved memories yet.</p>
  }

  // Group by path so re-approved supersessions collapse to one visible row
  // per path (§3: approving a duplicate path archives the prior row).
  const byPath = new Map<string, AgentMemory[]>()
  for (const memory of memories) {
    const list = byPath.get(memory.path) ?? []
    list.push(memory)
    byPath.set(memory.path, list)
  }

  return (
    <div className="space-y-2">
      {[...byPath.entries()].map(([path, group]) => (
        <div key={path} className="space-y-1.5">
          {group.map((memory) => (
            <div
              key={memory.id}
              data-memory-path={memory.path}
              className="space-y-2 rounded-lg border bg-card px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="min-w-0 truncate text-xs font-medium">{memory.path}</code>
                {memory.humanEdited && (
                  <AppTooltip content="Protected: the agent cannot modify this; it can only ask.">
                    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      Human-edited
                    </Badge>
                  </AppTooltip>
                )}
                <span className="text-[10px] text-muted-foreground">v{memory.version}</span>
              </div>

              <div className="rounded-md border bg-background/60 px-2 py-1.5 text-xs">
                <ChatMarkdown content={memory.content} />
              </div>

              {canEdit(memory, roleLevel, username) && (
                <div className="flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={() => setEditing(memory)}
                  >
                    <Pencil data-icon="inline-start" />
                    Edit
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {editing && (
        <EditMemoryDialog
          memory={editing}
          onClose={() => setEditing(null)}
          onSave={async (content) => {
            await onEdit(editing, content)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function EditMemoryDialog({
  memory,
  onClose,
  onSave,
}: {
  memory: AgentMemory
  onClose: () => void
  onSave: (content: string) => Promise<void>
}) {
  const [content, setContent] = useState(memory.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setBusy(true)
    setError(null)
    try {
      await onSave(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.")
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
          <DialogTitle>Edit {memory.path}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-40 font-mono text-xs"
            aria-label="Memory content"
          />
          {error && <FieldError role="alert">{error}</FieldError>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || content === memory.content}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
