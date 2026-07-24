import { useState, useEffect, useMemo } from "react"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { compareByCanonicalBookOrder } from "@/lib/file-labeling/bible-book-names"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"
import { canSubmitAssignment } from "@/lib/sync/role-policy"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
 * chapter scope to an org member. Collapsed to an "Assign…" button until
 * opened; emits one assignment.create on submit. Book scope = whole file;
 * chapter scope = one or more real chapters checked from the file's chapter
 * list (each the canonical_ref prefix, e.g. "GEN 1", matched server-side via
 * LIKE). AQU-677: post-editors work contiguous chapter runs, so the chapter
 * picker is multi-select — every checked chapter lands in a single
 * assignment.create's `scope[]` (one assignment, one deadline, one progress
 * bar across the run). Checking none = whole book; the member selector stays
 * single-select.
 */
export interface AssignWorkProps {
  projectId: string
  /** Files in the project (book = one file). */
  files: { id: string; name: string }[]
  orgId: number
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
  orgId,
  jwt,
  author,
  roleLevel = DEFAULT_ROLE_LEVEL,
  allowSelfAssignment = false,
  callerUserId = null,
  onAssigned,
}: AssignWorkProps) {
  const isSelfAssignMode = roleLevel < DEFAULT_ROLE_LEVEL
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [assigneeId, setAssigneeId] = useState<number | "">(
    isSelfAssignMode && callerUserId != null ? callerUserId : "",
  )
  const [fileId, setFileId] = useState(files[0]?.id ?? "")
  const [selectedChapters, setSelectedChapters] = useState<string[]>([])
  const [chapters, setChapters] = useState<string[]>([])
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // AQU-582: list books in canonical Bible reading order (Genesis → Revelation)
  // rather than the incoming prop order, matching the sidebar and the Assign
  // modal. Non-book files fall back to alphabetic via the shared comparator.
  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => compareByCanonicalBookOrder(a.name, b.name)),
    [files],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listOrgMembers(jwt, orgId)
      .then((m) => { if (!cancelled) setMembers(m) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [open, jwt, orgId])

  // Load the selected file's chapters for the picker; clear the checked
  // chapters when the file changes so stale chapters can't leak across books.
  useEffect(() => {
    if (!open || !fileId) return
    let cancelled = false
    setSelectedChapters([])
    getFileChapters(jwt, projectId, fileId)
      .then((cs) => { if (!cancelled) setChapters(cs) })
      .catch(() => { if (!cancelled) setChapters([]) })
    return () => { cancelled = true }
  }, [open, fileId, jwt, projectId])

  // Keep the checked chapters in canonical (server-natural-sorted) order
  // regardless of click order — drives both the scope[] and the label.
  const orderedChosen = useMemo(
    () => chapters.filter((ch) => selectedChapters.includes(ch)),
    [chapters, selectedChapters],
  )
  const allChaptersChecked =
    chapters.length > 0 && orderedChosen.length === chapters.length

  function toggleChapter(ch: string, checked: boolean) {
    setSelectedChapters((prev) =>
      checked ? [...prev, ch] : prev.filter((c) => c !== ch),
    )
  }

  async function submit() {
    if (assigneeId === "") {
      setError("Choose an assignee.")
      return
    }
    if (!fileId) {
      setError("Choose a file.")
      return
    }
    if (!canSubmitAssignment(roleLevel, allowSelfAssignment, callerUserId, Number(assigneeId))) {
      setError("You can only assign work to yourself.")
      return
    }
    const fileName = files.find((f) => f.id === fileId)?.name ?? "file"
    // AQU-677: zero checked chapters = whole book (unchanged single-book path);
    // one or more = a single chapters-scope assignment listing every chapter.
    const chosen = orderedChosen
    const scopeKind = chosen.length > 0 ? "chapters" : "books"
    const scope =
      chosen.length > 0 ? chosen.map((ch) => ({ fileId, chapter: ch })) : [{ fileId }]
    const scopeLabel =
      chosen.length > 0 ? `${fileName} · ${chosen.join(", ")}` : fileName
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
      setSelectedChapters([])
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
              items={sortedFiles.map((f) => ({ value: f.id, label: f.name }))}
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
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-chapters">Chapters</FieldLabel>
            {chapters.length === 0 ? (
              <FieldDescription>
                Whole book — this file has no chapters to narrow to.
              </FieldDescription>
            ) : (
              <>
                <div
                  className="mb-1 flex items-center justify-between text-xs text-muted-foreground"
                >
                  <span>
                    {orderedChosen.length === 0
                      ? "Whole book (none checked)"
                      : `${orderedChosen.length} chapter${orderedChosen.length === 1 ? "" : "s"} selected`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-1 py-0 text-xs"
                    disabled={busy}
                    onClick={() =>
                      setSelectedChapters(allChaptersChecked ? [] : [...chapters])
                    }
                  >
                    {allChaptersChecked ? "Clear all" : "Select all"}
                  </Button>
                </div>
                <div
                  id="assign-work-chapters"
                  role="group"
                  aria-label="Chapters"
                  className="max-h-40 overflow-y-auto rounded-md border p-2"
                >
                  {chapters.map((ch) => (
                    <label
                      key={ch}
                      className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                    >
                      <Checkbox
                        checked={selectedChapters.includes(ch)}
                        onCheckedChange={(c) => toggleChapter(ch, c === true)}
                        disabled={busy}
                      />
                      {ch}
                    </label>
                  ))}
                </div>
              </>
            )}
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
