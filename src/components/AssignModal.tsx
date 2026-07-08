// AssignModal — "Assign…" workspace action (FRO-192).
//
// Scope kinds:
//   selection  → cells in the current editor selection (Set<string>)
//   verses     → all cells in the active file
//   chapters   → one or more chapters within the active file
//   books      → one or more files (book-level)
//
// Emits one `assignment.create` event per invocation via createAssignment().
// Role gate: renders for PROJECT_LEAD (500) and above unconditionally, OR for
// CONTRIBUTOR (400)+ when the org has opted into `allowSelfAssignment`
// (AQU-496) — in which case the assignee picker is locked to the caller
// themselves (a below-lead member may only claim work for THEMSELVES, never
// assign to anyone else). Server enforces the same floor + self-only carve-out
// in sync-worker/src/events/authorize.ts; the client gate is a UX affordance,
// not the security boundary.

import { useCallback, useEffect, useState } from "react"
import { UserCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProjectMember } from "@/lib/frontier/members"
import type { FileReference } from "@/lib/parsers/types"
import { createAssignment, getFileChapters, AssignmentEmitError } from "@/lib/sync/assignments"
import { ROLE } from "@/lib/frontier/roles"
import { canOpenAssignUi, canSubmitAssignment } from "@/lib/sync/role-policy"

type ScopeKind = "selection" | "verses" | "chapters" | "books"

interface AssignModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** The file currently open in the editor. Required for selection/verses/chapters scope. */
  activeFileId: string | null
  /** All project files. Used for the books scope. */
  projectFiles: FileReference[]
  /** Members eligible to be assigned (already fetched by parent). */
  members: ProjectMember[]
  /** Current user's role level — used to gate the modal. */
  roleLevel: number
  /**
   * AQU-496: whether the org allows below-lead (CONTRIBUTOR+) members to
   * self-assign. Default false — leads/maintainers-only, pre-AQU-496 behavior.
   */
  allowSelfAssignment?: boolean
  /**
   * AQU-496: the caller's own Frontier user id. Required to lock the assignee
   * picker to "self" when `roleLevel` is below PROJECT_LEAD — without it, a
   * below-lead caller sees no eligible assignee (fails closed, not open).
   */
  callerUserId?: number | null
  /** Current editor selection (cell ids). Used for the selection scope. */
  selectedCellIds: ReadonlySet<string>
  /** JWT for API calls. */
  jwt: string
  /** Author label stamped on the event (current username). */
  author: string
  /** Called after a successful assignment so the parent can refresh. */
  onAssigned: () => void
}

const SCOPE_OPTIONS: { value: ScopeKind; label: string }[] = [
  { value: "selection", label: "Current selection" },
  { value: "verses", label: "All verses in file" },
  { value: "chapters", label: "Chapters" },
  { value: "books", label: "Books (files)" },
]

export function AssignModal({
  open,
  onOpenChange,
  projectId,
  activeFileId,
  projectFiles,
  members,
  roleLevel,
  allowSelfAssignment = false,
  callerUserId = null,
  selectedCellIds,
  jwt,
  author,
  onAssigned,
}: AssignModalProps) {
  // AQU-496: below PROJECT_LEAD, the only reason this modal can be open at
  // all is the self-assign carve-out (see canOpenAssignUi gate below) — so
  // "below lead" and "self-assign mode" are equivalent here.
  const isSelfAssignMode = roleLevel < ROLE.PROJECT_LEAD

  const [scopeKind, setScopeKind] = useState<ScopeKind>("verses")
  const [selectedMemberId, setSelectedMemberId] = useState<string>("")
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [availableChapters, setAvailableChapters] = useState<string[]>([])
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [chaptersLoading, setChaptersLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState("")

  // Reset on open. Self-assign mode locks the assignee to the caller so
  // there's no accidental "assign to someone else" click before the picker
  // is disabled below.
  useEffect(() => {
    if (open) {
      setScopeKind(selectedCellIds.size > 0 ? "selection" : "verses")
      setSelectedMemberId(isSelfAssignMode && callerUserId != null ? String(callerUserId) : "")
      setSelectedFileIds(new Set())
      setSelectedChapters(new Set())
      setAvailableChapters([])
      setError(null)
      setNote("")
    }
  }, [open, selectedCellIds.size, isSelfAssignMode, callerUserId])

  // Fetch chapters when scope=chapters and activeFileId is set
  useEffect(() => {
    if (scopeKind !== "chapters" || !activeFileId || !jwt) return
    let cancelled = false
    setChaptersLoading(true)
    setAvailableChapters([])
    void getFileChapters(jwt, projectId, activeFileId)
      .then((chapters) => { if (!cancelled) setAvailableChapters(chapters) })
      .catch(() => { if (!cancelled) setAvailableChapters([]) })
      .finally(() => { if (!cancelled) setChaptersLoading(false) })
    return () => { cancelled = true }
  }, [scopeKind, activeFileId, jwt, projectId])

  const toggleFile = useCallback((fileId: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const toggleChapter = useCallback((ch: string) => {
    setSelectedChapters((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else next.add(ch)
      return next
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    setError(null)
    const member = members.find((m) => String(m.userId) === selectedMemberId)
    if (!member) { setError("Select a member."); return }

    // AQU-496 defense-in-depth: re-check even though the picker is already
    // locked to self in self-assign mode — the server is authoritative and
    // will 403 regardless, but this avoids a round-trip for the obvious case.
    if (!canSubmitAssignment(roleLevel, allowSelfAssignment, callerUserId, member.userId)) {
      setError("You can only assign work to yourself.")
      return
    }

    // Build scope + scopeLabel based on scopeKind
    let scope: { fileId: string; chapter?: string }[] = []
    let scopeLabel = ""
    let apiScopeKind: "books" | "chapters" = "books"

    if (scopeKind === "selection" || scopeKind === "verses") {
      if (!activeFileId) { setError("No file open."); return }
      const file = projectFiles.find((f) => f.id === activeFileId)
      scope = [{ fileId: activeFileId }]
      scopeLabel = scopeKind === "selection"
        ? `${selectedCellIds.size} verse(s) in ${file?.name ?? activeFileId}`
        : `All verses in ${file?.name ?? activeFileId}`
      apiScopeKind = "books"
    } else if (scopeKind === "chapters") {
      if (!activeFileId) { setError("No file open."); return }
      if (selectedChapters.size === 0) { setError("Select at least one chapter."); return }
      const file = projectFiles.find((f) => f.id === activeFileId)
      scope = Array.from(selectedChapters).map((ch) => ({ fileId: activeFileId, chapter: ch }))
      scopeLabel = `${Array.from(selectedChapters).join(", ")} in ${file?.name ?? activeFileId}`
      apiScopeKind = "chapters"
    } else if (scopeKind === "books") {
      if (selectedFileIds.size === 0) { setError("Select at least one book/file."); return }
      scope = Array.from(selectedFileIds).map((fid) => ({ fileId: fid }))
      const names = Array.from(selectedFileIds)
        .map((fid) => projectFiles.find((f) => f.id === fid)?.name ?? fid)
      scopeLabel = names.join(", ")
      apiScopeKind = "books"
    }

    // Use activeFileId as the routing file for the event token.
    const routeFileId = activeFileId ?? scope[0]?.fileId
    if (!routeFileId) { setError("No file available for routing."); return }

    setSubmitting(true)
    try {
      await createAssignment({
        jwt,
        projectId,
        fileId: routeFileId,
        author,
        assigneeUserId: member.userId,
        scope,
        scopeKind: apiScopeKind,
        scopeLabel,
        note: note.trim() || null,
      })
      onAssigned()
      onOpenChange(false)
    } catch (e) {
      if (e instanceof AssignmentEmitError) {
        setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : "Unknown error")
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    members, selectedMemberId, scopeKind, activeFileId, projectFiles,
    selectedCellIds.size, selectedChapters, selectedFileIds,
    jwt, projectId, author, note, onAssigned, onOpenChange,
    roleLevel, allowSelfAssignment, callerUserId,
  ])

  // Role gate (AQU-496): PROJECT_LEAD (500)+ always renders; below that, only
  // when the org's allowSelfAssignment carve-out applies (canOpenAssignUi).
  if (!canOpenAssignUi(roleLevel, allowSelfAssignment)) return null

  // AQU-496: in self-assign mode the picker is locked to the caller's own
  // membership row. If callerUserId couldn't be resolved (edge case — caller
  // not found in the project's member list), the picker has no options and
  // canSubmit stays false, so this fails closed rather than open.
  const assigneeItems = isSelfAssignMode
    ? members
        .filter((m) => m.userId === callerUserId)
        .map((m) => ({ value: String(m.userId), label: `${m.username} (you)` }))
    : [
        { value: "", label: "Select member…" },
        ...members.map((m) => ({ value: String(m.userId), label: m.username })),
      ]

  const canSubmit = Boolean(selectedMemberId) && !submitting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-4 w-4" />
            Assign work
          </DialogTitle>
        </DialogHeader>

        <FieldGroup className="py-1">
          <Field>
            <FieldLabel htmlFor="assign-modal-scope">Scope</FieldLabel>
            <Select
              items={SCOPE_OPTIONS.map((opt) => ({
                value: opt.value,
                label:
                  opt.value === "selection" && selectedCellIds.size > 0
                    ? `${opt.label} (${selectedCellIds.size})`
                    : opt.label,
              }))}
              value={scopeKind}
              onValueChange={(v) => setScopeKind(v as ScopeKind)}
            >
              <SelectTrigger id="assign-modal-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SCOPE_OPTIONS.map((opt) => {
                    const disabled = opt.value === "selection" && selectedCellIds.size === 0
                    return (
                      <SelectItem key={opt.value} value={opt.value} disabled={disabled}>
                        {opt.label}
                        {opt.value === "selection" && selectedCellIds.size > 0
                          ? ` (${selectedCellIds.size})`
                          : ""}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {scopeKind === "books" && (
            <Field>
              <FieldLabel>Files / books</FieldLabel>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2">
                {projectFiles.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedFileIds.has(f.id)}
                      onCheckedChange={() => toggleFile(f.id)}
                      className="size-3"
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {scopeKind === "chapters" && (
            <Field>
              <FieldLabel>Chapters</FieldLabel>
              {chaptersLoading ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  Loading chapters…
                </div>
              ) : availableChapters.length === 0 ? (
                <p className="text-xs text-muted-foreground">No chapters found in this file.</p>
              ) : (
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2">
                  {availableChapters.map((ch) => (
                    <label key={ch} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50">
                      <Checkbox
                        checked={selectedChapters.has(ch)}
                        onCheckedChange={() => toggleChapter(ch)}
                        className="size-3"
                      />
                      {ch}
                    </label>
                  ))}
                </div>
              )}
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="assign-modal-assignee">Assign to</FieldLabel>
            <Select
              items={assigneeItems}
              value={selectedMemberId}
              onValueChange={(v) => setSelectedMemberId(v ?? "")}
              disabled={isSelfAssignMode}
            >
              <SelectTrigger id="assign-modal-assignee" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {assigneeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {isSelfAssignMode && (
              <FieldDescription>
                Self-assignment is on — you can claim this work for yourself. Only leads and
                maintainers can assign work to someone else.
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="assign-modal-note">Note (optional)</FieldLabel>
            <Textarea
              id="assign-modal-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="resize-none"
              placeholder="Any context for the assignee…"
            />
          </Field>

          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? <Spinner className="mr-1" /> : null}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
