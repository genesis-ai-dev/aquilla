import { useState, useEffect, useMemo } from "react"
import { fetchProjectRoster, partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import { compareByCanonicalBookOrder, getBookName } from "@/lib/file-labeling/bible-book-names"
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
 * Manager affordance (project_lead+) on the project overview: assign a book or
 * chapter scope to a project member. Collapsed to an "Assign…" button until
 * opened; emits one assignment.create on submit. Book scope = whole file;
 * chapter scope = a real chapter picked from the file's chapter dropdown
 * (the canonical_ref prefix, e.g. "GEN 1", matched server-side via LIKE).
 */
/**
 * AQU-678: the "Book" dropdown must list every book fully spelled out and in
 * canonical position, matching the sidebar. A file's `name` can be an
 * abbreviation or a locale rename (two data sources — see the issue), so we
 * resolve the canonical English book name from its stable `bookCode` when we
 * have one and fall back to the raw `name` for non-scripture files. Sorting on
 * the resolved label keeps a book like Ezekiel in its canonical slot even when
 * its file name is a non-canonical abbreviation the ordinal lookup can't match.
 */
function bookLabel(f: { name: string; bookCode?: string }): string {
  return (f.bookCode ? getBookName(f.bookCode) : undefined) ?? f.name
}

export interface AssignWorkProps {
  projectId: string
  /** Files in the project (book = one file). */
  files: { id: string; name: string; bookCode?: string }[]
  jwt: string
  /** Manager's username — stamped as the event author (server re-verifies). */
  author: string
  /** Caller authority used by the optional self-assignment carve-out. */
  roleLevel?: number
  allowSelfAssignment?: boolean
  /** Caller identity used to guarantee below-lead assignments target self. */
  callerUserId?: number | null
  /** Called after a successful assign so the parent can refresh rollups. */
  onAssigned?: () => void
}

const DEFAULT_ROLE_LEVEL = 500

export function AssignWork({
  projectId,
  files,
  jwt,
  author,
  roleLevel = DEFAULT_ROLE_LEVEL,
  allowSelfAssignment = false,
  callerUserId = null,
  onAssigned,
}: AssignWorkProps) {
  const isSelfAssignMode = roleLevel < DEFAULT_ROLE_LEVEL
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [assigneeId, setAssigneeId] = useState<number | "">(
    isSelfAssignMode && callerUserId != null ? callerUserId : "",
  )
  const [fileId, setFileId] = useState(files[0]?.id ?? "")
  const [chapter, setChapter] = useState("")
  const [chapters, setChapters] = useState<string[]>([])
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // AQU-582 / AQU-678: list books in canonical Bible reading order (Genesis →
  // Revelation) rather than the incoming prop order, matching the sidebar and
  // the Assign modal, and label each with its fully spelled-out canonical name
  // (via bookLabel) so abbreviations don't leak through. Sorting on the resolved
  // label keeps every book in its canonical slot; non-book files fall back to
  // alphabetic via the shared comparator.
  const sortedFiles = useMemo(
    () =>
      files
        .map((f) => ({ ...f, label: bookLabel(f) }))
        .sort((a, b) => compareByCanonicalBookOrder(a.label, b.label)),
    [files],
  )

  // AQU-676: fetch the project's effective roster (same source AssignModal's
  // hosts use), not the org roster — an org roster both floods the picker with
  // org-baseline-only people and misses project-only invitees (AQU-474).
  // Roster-hidden / no-access resolve to an empty list, failing closed.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchProjectRoster(jwt, projectId)
      .then((r) => { if (!cancelled) setMembers(r.kind === "ok" ? r.members : []) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [open, jwt, projectId])

  // AQU-676: the assignee picker must list only the project's own members,
  // never everyone with org-baseline access. partitionMembers (AQU-454) keeps
  // only members with a project-specific path (override / group / creator);
  // org-baseline-only members drop out. Self-assign mode is exempt (the caller
  // claims work for themselves) — it filters the raw roster to the caller.
  const eligibleMembers = useMemo(
    () => partitionMembers(members).projectMembers,
    [members],
  )

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
    if (assigneeId === "") {
      setError("Choose an assignee.")
      return
    }
    if (!fileId) {
      setError("Choose a file.")
      return
    }
    // AQU-676 defense-in-depth: the picker already hides org-baseline-only
    // members, but re-check on submit so a stale/forced selection can't route
    // an assignment to someone outside the project.
    if (!isSelfAssignMode && !eligibleMembers.some((m) => m.userId === Number(assigneeId))) {
      setError("You can only assign work to a project member.")
      return
    }
    if (!canSubmitAssignment(roleLevel, allowSelfAssignment, callerUserId, Number(assigneeId))) {
      setError("You can only assign work to yourself.")
      return
    }
    const fileName = sortedFiles.find((f) => f.id === fileId)?.label ?? "file"
    const chap = chapter.trim()
    const scopeKind = chap ? "chapters" : "books"
    const scope = chap ? [{ fileId, chapter: chap }] : [{ fileId }]
    const scopeLabel = chap ? `${fileName} · ${chap}` : fileName
    const deadline = deadlineDate ? dateToDeadlineString(deadlineDate) : ""
    setBusy(true)
    setError(null)
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
      setChapter("")
      setDeadlineDate(undefined)
      setOpen(false)
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
                      // AQU-676: project members only — org-baseline-only people are excluded.
                      ...eligibleMembers.map((m) => ({ value: String(m.userId), label: m.username })),
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
                      {eligibleMembers.map((m) => (
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
              items={sortedFiles.map((f) => ({ value: f.id, label: f.label }))}
              value={fileId}
              onValueChange={(v) => setFileId(v ?? "")}
              disabled={busy}
            >
              <SelectTrigger id="assign-work-book" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sortedFiles.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
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
            disabled={busy}
          >
            Assign
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { setOpen(false); setError(null) }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
    </div>
  )
}
