// AQU-538 §3.4 — minimal, reusable lane/file scope editor for a single
// (project, member) pair. Extracted so the members matrix can offer the
// same "click to edit scopes" gesture MembersPanel's per-row editor gives
// contributors/reviewers, without duplicating the PUT-scopes wiring or
// reaching into MembersPanel.tsx (out of scope for this slice — it has its
// own project-context scoping loaded from SharePanel, which doesn't fit the
// matrix's "any project, any member" shape).
//
// Lanes are a checkbox list of the project's own languages, loaded with the
// member's scopes when the editor opens (one settings fetch per open, not per
// cell). The free-text lane code it used to take had two failures (AQU-581
// review): the default lane's code is the empty string, so nobody could be
// limited to a project's MAIN language — the only language most projects have
// — and a typo silently left a lane coordinator with no lanes at all. The
// free-text input survives only as a fallback when the settings can't load.
// File scopes stay chips: they are rare and set elsewhere.

import { useState } from "react"
import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { fetchMemberScopes, putMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { useI18n } from "@/lib/i18n/I18nProvider"

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
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<MemberScope[]>([])
  const [loading, setLoading] = useState(false)
  const [newLane, setNewLane] = useState("")
  // The project's languages: `""` is the main language. Null until loaded, or
  // when the settings couldn't be read (the free-text fallback then shows).
  const [laneOptions, setLaneOptions] = useState<Array<{ value: string; label: string }> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    setError(null)
    setNewLane("")
    setLoading(true)
    void Promise.all([fetchMemberScopes(jwt, projectId, userId), fetchProjectSettings(jwt, projectId)]).then(
      ([scopes, settings]) => {
        setDraft(scopes ?? [])
        setLaneOptions(
          settings
            ? [
                {
                  value: "",
                  label: settings.settings.targetLanguage || t("org.memberLaneScopeEditor.mainLanguageFallback"),
                },
                ...(settings.settings.targetLanes ?? []).map((lane) => ({ value: lane, label: lane })),
              ]
            : null,
        )
        setLoading(false)
      },
    )
  }

  function toggleLane(value: string) {
    setDraft((prev) =>
      prev.some((s) => s.kind === "lane" && s.value === value)
        ? prev.filter((s) => !(s.kind === "lane" && s.value === value))
        : [...prev, { kind: "lane", value }],
    )
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
            aria-label={t("org.memberLaneScopeEditor.editScopesAriaLabel", { username })}
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
        <p className="font-medium">{t("org.memberLaneScopeEditor.scopesHeading", { username })}</p>
        {loading ? (
          <div className="flex items-center text-muted-foreground">
            <Spinner className="size-3" />
          </div>
        ) : (
          <>
            {draft.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("org.memberLaneScopeEditor.unscopedFullAccess")}
              </p>
            )}
            {laneOptions && (
              <fieldset className="space-y-1">
                <legend className="text-[11px] text-muted-foreground">
                  {t("org.memberLaneScopeEditor.languagesLegend")}
                </legend>
                {[
                  ...laneOptions,
                  // A lane scope naming no language in this project (an old
                  // typo, or a lane since removed): shown so it can be unticked.
                  ...draft
                    .filter((s) => s.kind === "lane" && !laneOptions.some((o) => o.value === s.value))
                    .map((s) => ({
                      value: s.value,
                      label: t("org.memberLaneScopeEditor.unknownLane", { lane: s.value }),
                    })),
                ].map((lane) => (
                  <label key={lane.value || "__main__"} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={draft.some((s) => s.kind === "lane" && s.value === lane.value)}
                      onCheckedChange={() => toggleLane(lane.value)}
                      aria-label={t("org.membersPanel.laneCheckboxAriaLabel", { lane: lane.label })}
                    />
                    <span>{lane.label}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <div className="flex flex-wrap gap-1">
              {draft.filter((s) => !laneOptions || s.kind === "file").map((s) => (
                <span
                  key={`${s.kind}:${s.value}`}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
                >
                  {s.kind === "lane" ? s.value || "default" : `file:${s.value}`}
                  <button
                    type="button"
                    aria-label={t("org.teamDetail.removeAriaLabel", { name: s.value || "default" })}
                    onClick={() => removeScope(s)}
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
            {!laneOptions && (
              <div className="flex items-center gap-1">
                <Input
                  value={newLane}
                  onChange={(e) => setNewLane(e.target.value)}
                  placeholder={t("org.memberLaneScopeEditor.laneCodePlaceholder")}
                  aria-label={t("org.memberLaneScopeEditor.newLaneCodeAriaLabel")}
                  className="h-7 text-[11px]"
                />
                <Button
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={addLane}
                  disabled={!newLane.trim()}
                >
                  {t("common.add")}
                </Button>
              </div>
            )}
            <Button className="w-full" onClick={handleSave} disabled={saving}>
              {saving && <Spinner className="me-1.5 size-3.5" />}
              {t("org.memberLaneScopeEditor.saveScopesButton")}
            </Button>
            {error && <p className="text-destructive">{error}</p>}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
