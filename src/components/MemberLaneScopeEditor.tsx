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
//
// AQU-1783 — the popover also REPORTS access, and reports it from the lane
// grants (`project_member_lane_roles`), because that is the table the read
// wall reads. Reading the scopes instead is what made it say "Unscoped — full
// access" about a contributor the wall had walled off: scopes and grants drift
// apart whenever grants were never written or lag behind the lane set. The
// verdict is `memberLaneAccess`, which applies the wall's own rule, so this
// screen cannot claim access the server denies.

import { useState } from "react"
import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
  fetchMemberScopeView,
  putMemberScopes,
  type MemberLaneAccessPayload,
  type MemberScope,
} from "@/lib/sync/member-scopes"
import { fetchProjectSettings, type ProjectLaneView } from "@/lib/sync/project-settings"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { laneLanguageForTag, laneRowLabel } from "@/lib/lanes/lane-language"
import { resolveLaneScopeValue } from "@/lib/lanes/scope-ids"
import { memberLaneAccess, type MemberLaneAccessVerdict } from "@/lib/lanes/grant-gap"
import { useI18n } from "@/lib/i18n/I18nProvider"

export interface MemberLaneScopeEditorProps {
  jwt: string
  projectId: string
  userId: number
  username: string
  /** Rendered as the popover's clickable trigger (e.g. the chip row). */
  trigger: ReactNode
  /** Called with the freshly-saved scopes so the caller's chip cache can be
   * updated in place without a full matrix refetch. AQU-1607: the lane names
   * ride along, because a lane just granted is not in any cache the caller
   * built before the save, and a chip would print its id. */
  onSaved: (scopes: MemberScope[], laneNames: Record<string, string>) => void
}

/** A lane row's display string: its name, else its tag, else "main language".
 *  AQU-1586: the name is read through `laneRowLabel`, so a row that names
 *  nothing shows the language it records before its tag — a tag can be the
 *  opaque lane id. */
function laneOptionLabel(lane: ProjectLaneView, mainLanguageLabel: string): string {
  const label = laneRowLabel(lane)
  if (label) return label
  const tag = (lane.legacyTag ?? "").trim()
  return tag !== "" ? tag : mainLanguageLabel
}

/**
 * AQU-1607: stored lane scopes as lane ids. A value that already is one is
 * kept; a legacy tag naming exactly one lane becomes that lane's id; one
 * naming none or two is left alone so it still shows (and can be unticked).
 */
function normalizeLaneScopes(
  scopes: readonly MemberScope[],
  lanes: readonly ProjectLaneView[],
): MemberScope[] {
  if (lanes.length === 0) return [...scopes]
  return scopes.map((scope) => {
    if (scope.kind !== "lane") return scope
    const resolved = resolveLaneScopeValue(scope.value, lanes)
    return resolved.ok ? { kind: "lane", value: resolved.laneId } : scope
  })
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
  // AQU-1783: the member's lane GRANTS as the server reports them. Null until
  // loaded, and stays null when the server said nothing — the caller is not a
  // project lead, the project has no lane rows, or it predates the field. Null
  // means "say nothing about grants", never "no access".
  const [laneAccess, setLaneAccess] = useState<MemberLaneAccessPayload | null>(null)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    setError(null)
    setNewLane("")
    setLoading(true)
    setLaneAccess(null)
    void Promise.all([fetchMemberScopeView(jwt, projectId, userId), fetchProjectSettings(jwt, projectId)]).then(
      ([view, settings]) => {
        const scopes = view?.scopes ?? null
        setLaneAccess(view?.laneAccess ?? null)
        // AQU-1607: a lane scope is a lane id, so the checkboxes are the
        // project's lane ROWS — two lanes of one language are two boxes. A
        // scope still holding a legacy tag is resolved to its lane id as it
        // loads, so it shows ticked against the right lane and saves as an
        // id. A server predating lane rows keeps the old tag list.
        const rows = (settings?.lanes ?? []).filter(
          (lane) => lane.role === "target" && !lane.archivedAt,
        )
        setDraft(normalizeLaneScopes(scopes ?? [], rows))
        const defaultLanguage = settings
          ? laneLanguageForTag("", settings.lanes, settings.settings) ?? ""
          : ""
        setLaneOptions(
          rows.length > 0
            ? rows.map((lane) => ({
                value: lane.id,
                label: laneOptionLabel(lane, t("org.memberLaneScopeEditor.mainLanguageFallback")),
              }))
            : settings
              ? [
                  {
                    value: "",
                    label: defaultLanguage || t("org.memberLaneScopeEditor.mainLanguageFallback"),
                  },
                  ...extraRegistryLanes(settings.settings.targetLanes, defaultLanguage).map((lane) => ({ value: lane, label: lane })),
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
      // AQU-1783: the PUT rewrote the grants too, so take the server's fresh
      // view rather than leaving a stale list behind the next open.
      if (saved.laneAccess) setLaneAccess(saved.laneAccess)
      onSaved(saved.scopes, saved.laneNames)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /**
   * AQU-1783: repair a grant gap in one click. An empty lane-scope set is the
   * write that makes `planLaneGrants` grant every current lane, so this saves
   * the member's FILE scopes alone — today's accidental repair, made explicit.
   * Offered for unscoped members only: re-granting a deliberately scoped
   * member would silently widen their access.
   *
   * The popover stays open and takes the server's refreshed grants, so the
   * list updates in place without a page reload.
   */
  async function handleGrantAllLanes() {
    setSaving(true)
    setError(null)
    try {
      const fileScopes = draft.filter((scope) => scope.kind === "file")
      const saved = await putMemberScopes(jwt, projectId, userId, fileScopes)
      setDraft(saved.scopes)
      if (saved.laneAccess) setLaneAccess(saved.laneAccess)
      onSaved(saved.scopes, saved.laneNames)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // The verdict the screen prints. Null while the server has said nothing.
  const verdict: MemberLaneAccessVerdict | null = laneAccess
    ? memberLaneAccess({
        memberRoleLevel: laneAccess.memberRoleLevel,
        grants: laneAccess.grants,
        targetLanes: laneAccess.targetLanes,
        laneScopeCount: draft.filter((scope) => scope.kind === "lane").length,
        readWallEnabled: laneAccess.readWallEnabled,
      })
    : null
  const restricted = verdict?.kind === "restricted" ? verdict : null
  // Maintainer and above read every lane through their role; the wall being
  // off is NOT this case — there the popover keeps saying what it always did.
  const byRole = verdict?.kind === "unrestricted" && verdict.reason === "role"

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
            {/* AQU-1783: "Unscoped — full access" is only true when the
                grants really do cover every current lane. Where the server
                reported a gap, the list below says so instead. */}
            {draft.length === 0 && !byRole && (restricted === null || restricted.coversAll) && (
              <p className="text-[11px] text-muted-foreground">
                {t("org.memberLaneScopeEditor.unscopedFullAccess")}
              </p>
            )}
            {byRole && (
              <p className="text-[11px] text-muted-foreground" data-testid="member-lane-grants-by-role">
                {t("org.memberLaneScopeEditor.visibleByRole")}
              </p>
            )}
            {restricted && (
              <div className="space-y-1" data-testid="member-lane-grants">
                <p className="text-[11px] text-muted-foreground">
                  {t("org.memberLaneScopeEditor.grantsLegend")}
                </p>
                <ul className="space-y-0.5">
                  {restricted.lanes.map((lane) => (
                    <li key={lane.laneId} className="flex items-center justify-between gap-1.5">
                      <span className={lane.granted ? undefined : "text-muted-foreground"}>
                        {lane.name || t("org.memberLaneScopeEditor.mainLanguageFallback")}
                      </span>
                      {!lane.granted && (
                        <span className="shrink-0 rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                          {t("org.memberLaneScopeEditor.laneNoAccess")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {restricted?.warn && (
              <div className="space-y-1 rounded border border-destructive/40 bg-destructive/5 p-1.5" role="alert">
                <p className="text-[11px] text-destructive">
                  {t("org.memberLaneScopeEditor.grantGapWarning")}
                </p>
                <Button
                  variant="outline"
                  className="h-7 w-full px-2 text-[11px]"
                  onClick={handleGrantAllLanes}
                  disabled={saving}
                >
                  {saving && <Spinner className="me-1.5 size-3" />}
                  {t("org.memberLaneScopeEditor.grantAllButton")}
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  {t("org.memberLaneScopeEditor.grantAllHint")}
                </p>
              </div>
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
