import { useState, useEffect } from "react"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"
import { Button } from "@/components/ui/button"
import {
  DatePicker,
  dateToDeadlineString,
} from "@/components/ui/date-picker"
import {
  Field,
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
 * chapter scope = a real chapter picked from the file's chapter dropdown
 * (the canonical_ref prefix, e.g. "GEN 1", matched server-side via LIKE).
 */
export interface AssignWorkProps {
  projectId: string
  /** Files in the project (book = one file). */
  files: { id: string; name: string }[]
  orgId: number
  jwt: string
  /** Manager's username — stamped as the event author (server re-verifies). */
  author: string
  /** Called after a successful assign so the parent can refresh rollups. */
  onAssigned?: () => void
}

export function AssignWork({ projectId, files, orgId, jwt, author, onAssigned }: AssignWorkProps) {
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [assigneeId, setAssigneeId] = useState<number | "">("")
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
              items={[
                { value: "", label: "Select member…" },
                ...members.map((m) => ({ value: String(m.userId), label: m.username })),
              ]}
              value={assigneeId === "" ? "" : String(assigneeId)}
              onValueChange={(v) => setAssigneeId(v == null || v === "" ? "" : Number(v))}
              disabled={busy}
            >
              <SelectTrigger id="assign-work-assignee" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">Select member…</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={String(m.userId)}>{m.username}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
