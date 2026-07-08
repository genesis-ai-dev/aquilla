import { useState, useEffect } from "react"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"
import { canSubmitAssignment } from "@/lib/sync/role-policy"
import { Button } from "@/components/ui/button"
import {
  DatePicker,
  dateToDeadlineString,
} from "@/components/ui/date-picker"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * Manager affordance (project_lead+ by default) on the project overview:
 * assign a book or chapter scope to an org member. Collapsed to an "Assign…"
 * button until opened; emits one assignment.create on submit. Book scope =
 * whole file; chapter scope = a real chapter picked from the file's chapter
 * dropdown (the canonical_ref prefix, e.g. "GEN 1", matched server-side via
 * LIKE).
 *
 * AQU-496: below-lead self-assignment is supported via the optional
 * `roleLevel` / `allowSelfAssignment` / `callerUserId` props — when the
 * caller's role is below project_lead but the org has opted into
 * allowSelfAssignment, the assignee picker locks to the caller themselves
 * (never anyone else; server re-enforces in sync-worker/events/authorize.ts).
 * Omitting these props preserves the original lead-only behavior byte for
 * byte (all three default to values that keep the pre-AQU-496 gate).
 *
 * SWARM-TODO(AQU-496): the only current caller (org/ProjectOverview.tsx,
 * "Team" card) does not pass roleLevel/allowSelfAssignment/callerUserId yet —
 * that file is out of this worktree's ownership (concurrent AQU-49x lane), so
 * self-assignment isn't reachable from that surface until it's wired up
 * there too (its own `canAssign` gate at ~line 478 also needs the same
 * `canOpenAssignUi` swap that ProjectWorkspace.tsx got). The fully-wired,
 * verifiable click-path today is ProjectWorkspace.tsx's AssignModal.
 */
export interface AssignWorkProps {
  projectId: string
  /** Files in the project (book = one file). */
  files: { id: string; name: string }[]
  orgId: number
  jwt: string
  /** Manager's username — stamped as the event author (server re-verifies). */
  author: string
  /**
   * AQU-496: caller's role level. Defaults to PROJECT_LEAD (500) so callers
   * that don't pass it keep the pre-AQU-496 "always a manager" assumption.
   */
  roleLevel?: number
  /** AQU-496: whether the org allows below-lead members to self-assign. */
  allowSelfAssignment?: boolean
  /** AQU-496: the caller's own Frontier user id, for self-assign mode. */
  callerUserId?: number | null
  /**
   * Called after a successful assign so the parent can refresh rollups.
   *
   * AQU-495 contract: this MUST actually revalidate whatever assignment list
   * the caller renders (e.g. re-run `getProjectAssignments`/`getWorkload`) —
   * it is not a generic "something changed" ping. A caller that points this
   * at an unrelated refresh (e.g. a portfolio/audio reload) will silently
   * leave its own list stale until a manual page refresh. See
   * SWARM-TODO(AQU-495) in `src/lib/sync/assignments.ts` for a known
   * violation of this contract.
   */
  onAssigned?: () => void
}

const DEFAULT_ROLE_LEVEL = 500 // ROLE.PROJECT_LEAD — see src/lib/sync/role-policy.ts

export function AssignWork({
  projectId,
  files,
  orgId,
  jwt,
  author,
  roleLevel = DEFAULT_ROLE_LEVEL,
  allowSelfAssignment = false,
  callerUserId = null,
  onAssigned,
}: AssignWorkProps) {
  // AQU-496: mirrors AssignModal's isSelfAssignMode — true only when the
  // caller is below lead (the only way this component is usable below lead
  // is via the allowSelfAssignment carve-out; callers gate rendering on
  // canOpenAssignUi upstream, same contract as AssignModal).
  const isSelfAssignMode = roleLevel < DEFAULT_ROLE_LEVEL
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [assigneeId, setAssigneeId] = useState<number | "">(
    isSelfAssignMode && callerUserId != null ? callerUserId : "",
  )
  const [fileId, setFileId] = useState(files[0]?.id ?? "")
  const [chapter, setChapter] = useState("")
  const [chapters, setChapters] = useState<string[]>([])
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listOrgMembers(jwt, orgId)
      .then((m) => { if (!cancelled) setMembers(m) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [open, jwt, orgId])

  // Load the selected file's chapters for the dropdown; reset the picked
  // chapter when the file changes so a stale chapter can't leak across books.
  useEffect(() => {
    if (!open || !fileId) return
    let cancelled = false
    setChapter("")
    getFileChapters(jwt, projectId, fileId)
      .then((cs) => { if (!cancelled) setChapters(cs) })
      .catch(() => { if (!cancelled) setChapters([]) })
    return () => { cancelled = true }
  }, [open, fileId, jwt, projectId])

  async function submit() {
    if (assigneeId === "" || !fileId) return
    // AQU-496 defense-in-depth: re-check even though the picker is already
    // locked to self in self-assign mode — the server is authoritative and
    // will 403 regardless.
    if (!canSubmitAssignment(roleLevel, allowSelfAssignment, callerUserId, Number(assigneeId))) {
      setError("You can only assign work to yourself.")
      return
    }
    const fileName = files.find((f) => f.id === fileId)?.name ?? "file"
    const chap = chapter.trim()
    const scopeKind = chap ? "chapters" : "books"
    const scope = chap ? [{ fileId, chapter: chap }] : [{ fileId }]
    const scopeLabel = chap ? `${fileName} · ${chap}` : fileName
    const deadline = deadlineDate ? dateToDeadlineString(deadlineDate) : ""
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await createAssignment({
        jwt,
        projectId,
        fileId,
        author,
        assigneeUserId: Number(assigneeId),
        scope,
        scopeKind,
        scopeLabel,
        deadline: deadline || null,
      })
      const name = members.find((m) => m.userId === Number(assigneeId))?.username ?? "member"
      setDone(`Assigned ${scopeLabel} to ${name}.`)
      setChapter("")
      setDeadlineDate(undefined)
      onAssigned?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Assign…
      </Button>
    )
  }

  return (
    <div role="group" aria-label="Assign work" className="mt-3 w-full rounded-md border p-3">
      <FieldGroup className="gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="assign-work-assignee">Assignee</FieldLabel>
            <Select
              items={
                isSelfAssignMode
                  ? members
                      .filter((m) => m.userId === callerUserId)
                      .map((m) => ({ value: String(m.userId), label: `${m.username} (you)` }))
                  : [
                      { value: "", label: "Select member…" },
                      ...members.map((m) => ({ value: String(m.userId), label: m.username })),
                    ]
              }
              value={assigneeId === "" ? "" : String(assigneeId)}
              onValueChange={(v) => setAssigneeId(v == null || v === "" ? "" : Number(v))}
              disabled={busy || isSelfAssignMode}
            >
              <SelectTrigger id="assign-work-assignee" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {isSelfAssignMode ? (
                    members
                      .filter((m) => m.userId === callerUserId)
                      .map((m) => (
                        <SelectItem key={m.userId} value={String(m.userId)}>{m.username} (you)</SelectItem>
                      ))
                  ) : (
                    <>
                      <SelectItem value="">Select member…</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.userId} value={String(m.userId)}>{m.username}</SelectItem>
                      ))}
                    </>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
            {isSelfAssignMode && (
              <FieldDescription>
                Self-assignment is on — you can claim this work for yourself.
              </FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-book">Book</FieldLabel>
            <Select
              items={files.map((f) => ({ value: f.id, label: f.name }))}
              value={fileId}
              onValueChange={(v) => setFileId(v ?? "")}
              disabled={busy}
            >
              <SelectTrigger id="assign-work-book" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {files.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-chapter">Chapter</FieldLabel>
            <Select
              items={[
                { value: "", label: "Whole book" },
                ...chapters.map((ch) => ({ value: ch, label: ch })),
              ]}
              value={chapter}
              onValueChange={(v) => setChapter(v ?? "")}
              disabled={busy}
            >
              <SelectTrigger id="assign-work-chapter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">Whole book</SelectItem>
                  {chapters.map((ch) => (
                    <SelectItem key={ch} value={ch}>{ch}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-deadline">Deadline (optional)</FieldLabel>
            <DatePicker
              id="assign-work-deadline"
              value={deadlineDate}
              onChange={setDeadlineDate}
              disabled={busy}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || assigneeId === "" || !fileId}
          >
            Assign
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { setOpen(false); setError(null); setDone(null) }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
        {done && <p className="text-sm text-foreground">{done}</p>}
      </FieldGroup>
    </div>
  )
}
