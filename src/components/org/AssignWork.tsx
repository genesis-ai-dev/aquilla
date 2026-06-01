import { useState, useEffect } from "react"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"

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
  const [deadline, setDeadline] = useState("")
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
      setDeadline("")
      onAssigned?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40"
      >
        Assign…
      </button>
    )
  }

  return (
    <div role="group" aria-label="Assign work" className="mt-3 w-full rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Assignee"
          value={assigneeId === "" ? "" : String(assigneeId)}
          onChange={(e) => setAssigneeId(e.target.value === "" ? "" : Number(e.target.value))}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="">Select member…</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>{m.username}</option>
          ))}
        </select>
        <select
          aria-label="Book"
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          {files.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <select
          aria-label="Chapter"
          value={chapter}
          onChange={(e) => setChapter(e.target.value)}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="">Whole book</option>
          {chapters.map((ch) => (
            <option key={ch} value={ch}>{ch}</option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Deadline (optional)"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
        <button
          onClick={submit}
          disabled={busy || assigneeId === "" || !fileId}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Assign
        </button>
        <button
          onClick={() => { setOpen(false); setError(null); setDone(null) }}
          disabled={busy}
          className="rounded-md border px-3 py-1 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {done && <p className="mt-2 text-sm text-foreground">{done}</p>}
    </div>
  )
}
