// AQU-538 §3.4 — minimal, reusable lane/file scope editor for a single
// (project, member) pair. Extracted so the members matrix can offer the
// same "click to edit scopes" gesture MembersPanel's per-row editor gives
// contributors/reviewers, without duplicating the PUT-scopes wiring or
// reaching into MembersPanel.tsx (out of scope for this slice — it has its
// own project-context scoping loaded from SharePanel, which doesn't fit the
// matrix's "any project, any member" shape).
//
// Deliberately minimal: unlike MembersPanel's editor (checkbox list against
// a project's known lane/file registry), this one edits the member's scopes
// as a freeform chip list — remove any existing lane/file scope, or type a
// new lane code to add one. The matrix has no cheap way to know a given
// project's lane registry without an extra per-cell settings fetch, and
// freeform editing over the scopes actually on the member is the simplest
// correct thing that doesn't require that plumbing.

import { useState } from "react"
import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { fetchMemberScopes, putMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"

export interface MemberLaneScopeEditorProps {
  jwt: string
  projectId: string
  userId: number
  username: string
  /** Rendered as the popover's clickable trigger (e.g. the chip row). */
  trigger: ReactNode
  /** Called with the freshly-saved scopes so the caller's chip cache can be
   * updated in place without a full matrix refetch. */
  onSaved: (scopes: MemberScope[]) => void
}

/** Freeform lane/file scope editor. Fetches the member's current scopes
 * fresh on open (never trusts a possibly-stale cache) so what's shown is
 * always the true server state at edit time. */
export function MemberLaneScopeEditor({
  jwt,
  projectId,
  userId,
  username,
  trigger,
  onSaved,
}: MemberLaneScopeEditorProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<MemberScope[]>([])
  const [loading, setLoading] = useState(false)
  const [newLane, setNewLane] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    setError(null)
    setNewLane("")
    setLoading(true)
    void fetchMemberScopes(jwt, projectId, userId).then((scopes) => {
      setDraft(scopes ?? [])
      setLoading(false)
    })
  }

  function removeScope(target: MemberScope) {
    setDraft((prev) => prev.filter((s) => !(s.kind === target.kind && s.value === target.value)))
  }

  function addLane() {
    const value = newLane.trim()
    if (!value) return
    setDraft((prev) =>
      prev.some((s) => s.kind === "lane" && s.value === value)
        ? prev
        : [...prev, { kind: "lane", value }],
    )
    setNewLane("")
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const saved = await putMemberScopes(jwt, projectId, userId, draft)
      onSaved(saved)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid={`matrix-scope-trigger-${userId}-${projectId}`}
            className="mt-0.5 block w-full truncate text-start text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            aria-label={`Edit ${username}'s lane scopes on this project`}
          />
        }
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        data-testid={`matrix-scope-editor-${userId}-${projectId}`}
        className="w-64 space-y-2 p-2 text-xs"
        side="right"
      >
        <p className="font-medium">{username}'s scopes</p>
        {loading ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {draft.length === 0 && (
                <span className="text-[11px] text-muted-foreground">Unscoped — full access</span>
              )}
              {draft.map((s) => (
                <span
                  key={`${s.kind}:${s.value}`}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
                >
                  {s.kind === "lane" ? s.value || "default" : `file:${s.value}`}
                  <button
                    type="button"
                    aria-label={`Remove ${s.value || "default"}`}
                    onClick={() => removeScope(s)}
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Input
                value={newLane}
                onChange={(e) => setNewLane(e.target.value)}
                placeholder="Lane code (e.g. es)"
                aria-label="New lane code"
                className="h-7 text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={addLane}
                disabled={!newLane.trim()}
              >
                Add
              </Button>
            </div>
            <Button size="sm" className="w-full" onClick={handleSave} disabled={saving}>
              {saving && <Spinner className="me-1.5 size-3.5" />}
              Save scopes
            </Button>
            {error && <p className="text-destructive">{error}</p>}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
