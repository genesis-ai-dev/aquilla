// AssignModal — "Assign…" workspace action (AQU-192).
//
// Scope kinds:
//   selection  → cells in the current editor selection (Set<string>)
//   verses     → all cells in the active file
//   chapters   → one or more chapters within the active file
//   books      → one or more files (book-level) — AQU-497: the "assign a
//                whole season" scope. Files are grouped by `corpusMarker`
//                (the real season/testament grouping the sidebar already
//                uses — see src/lib/sidebar/group-by-corpus.ts and the
//                season/episode auto-detector in src/lib/file-labeling/
//                detect.ts) with a "Select all" per group, so picking a
//                season's files is one click instead of N.
//
// Emits one `assignment.create` event per invocation for the
// selection/verses/chapters scopes via createAssignment(). The `books` scope
// (AQU-497) emits ONE event PER selected file via createBulkFileAssignments —
// see that function's doc comment in src/lib/sync/assignments.ts for why
// (per-file progress rows + per-file removability), sharing one deadline and
// one assignee across every file in the batch.
// Role gate: renders for PROJECT_LEAD (500) and above unconditionally, OR for
// CONTRIBUTOR (400)+ when the org has opted into `allowSelfAssignment`
// (AQU-496) — in which case the assignee picker is locked to the caller
// themselves (a below-lead member may only claim work for THEMSELVES, never
// assign to anyone else). Server enforces the same floor + self-only carve-out
// in sync-worker/src/events/authorize.ts; the client gate is a UX affordance,
// not the security boundary.

import { useCallback, useEffect, useMemo, useState } from "react"
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
  DialogBody,
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
import { DatePicker, dateToDeadlineString } from "@/components/ui/date-picker"
import { useT } from "@/lib/i18n/I18nProvider"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import type { FileReference, FileType } from "@/lib/parsers/types"
import {
  createAssignment,
  createBulkFileAssignments,
  getFileChapters,
  AssignmentEmitError,
} from "@/lib/sync/assignments"
import { ROLE } from "@/lib/frontier/roles"
import { canOpenAssignUi, canSubmitAssignment } from "@/lib/sync/role-policy"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"

type ScopeKind = "selection" | "verses" | "chapters" | "books"

interface AssignModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** The file currently open in the editor. Required for selection/verses/chapters scope. */
  activeFileId: string | null
  /** All project files. Used for the books scope. */
  projectFiles: FileReference[]
  /**
   * AQU-538 (§3.5): the project's extra target-language lanes (project.targetLanes,
   * overlaid by useProject). When non-empty, the modal shows a lane select so a
   * PM can pin the assignment to a lane; the default lane ('') is always the
   * first option. Omitted/empty ⇒ no lane select (N=1 projects are byte-identical
   * to the pre-lane flow).
   */
  targetLanes?: string[]
  /**
   * AQU-538 (§3.5): lane to pre-select — the surface's active lane (workspace)
   * or the lane row the modal was launched from (PM surfaces). Defaults to ''
   * (the default lane).
   */
  defaultLane?: string
  /**
   * AQU-728: display name of the default ('') lane — the project's own default
   * target language (e.g. "Portuguese"). The default lane IS a real language
   * lane, so the lane select must label it with this name rather than a generic
   * "Default language"; without it a Portuguese-default project renders no
   * "Portuguese" option and preselecting the launching default lane reads as
   * "default". Falls back to "Default language" when unknown/empty.
   */
  defaultLaneLabel?: string
  /**
   * The project's effective roster (already fetched by parent via
   * useProjectMembers). This includes people who only reach the project
   * through an org-wide role (AD-12 max-wins), so the assignee picker filters
   * it down to project-specific members — see AQU-676 / partitionMembers.
   */
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

// AQU-658: file types whose natural units are Bible verses/chapters. For
// everything else the scope copy is neutral ("Entire file" / "Sections" /
// "segment") so the modal reads correctly for non-scripture imports. When no
// file is in scope (launched from a project lane) we fall back to the neutral
// wording too.
const SCRIPTURE_FILE_TYPES: ReadonlySet<FileType> = new Set([
  "usfm",
  "ebible",
  "helloao",
  "sdbh",
])

// Scopes that operate on the currently-open editor file. When the modal is
// launched from a lane there is no active file, so these are disabled and the
// modal defaults to the "books" (file-picker) scope instead — otherwise the
// user hits a dead-end "No file open." on submit (AQU-658).
const ACTIVE_FILE_SCOPES: ReadonlySet<ScopeKind> = new Set([
  "selection",
  "verses",
  "chapters",
])

export function AssignModal({
  open,
  onOpenChange,
  projectId,
  activeFileId,
  projectFiles,
  targetLanes,
  defaultLane = "",
  defaultLaneLabel,
  members,
  roleLevel,
  allowSelfAssignment = false,
  callerUserId = null,
  selectedCellIds,
  jwt,
  author,
  onAssigned,
}: AssignModalProps) {
  const t = useT()
  // AQU-496: below PROJECT_LEAD, the only reason this modal can be open at
  // all is the self-assign carve-out (see canOpenAssignUi gate below) — so
  // "below lead" and "self-assign mode" are equivalent here.
  const isSelfAssignMode = roleLevel < ROLE.PROJECT_LEAD

  const [scopeKind, setScopeKind] = useState<ScopeKind>("verses")
  const [selectedMemberId, setSelectedMemberId] = useState<string>("")
  // AQU-538 (§3.5): the target-language lane this assignment is pinned to. '' =
  // default lane. Only surfaced when the project has extra lanes.
  const [selectedLane, setSelectedLane] = useState<string>(defaultLane)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [availableChapters, setAvailableChapters] = useState<string[]>([])
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [chaptersLoading, setChaptersLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)

  // Reset on open. Self-assign mode locks the assignee to the caller so
  // there's no accidental "assign to someone else" click before the picker
  // is disabled below.
  useEffect(() => {
    if (open) {
      // AQU-658: default to a scope that actually works from where the modal
      // was launched. With a selection → "selection"; with an open file but no
      // selection → "verses"; launched from a lane (no open file) → "books",
      // which surfaces the file picker instead of failing "No file open.".
      setScopeKind(
        selectedCellIds.size > 0 ? "selection" : activeFileId ? "verses" : "books",
      )
      setSelectedMemberId(isSelfAssignMode && callerUserId != null ? String(callerUserId) : "")
      setSelectedLane(defaultLane)
      setSelectedFileIds(new Set())
      setSelectedChapters(new Set())
      setAvailableChapters([])
      setError(null)
      setNote("")
      setDeadlineDate(undefined)
    }
  }, [open, selectedCellIds.size, activeFileId, isSelfAssignMode, callerUserId, defaultLane])

  // AQU-658: derive the unit vocabulary from the active file's type so the
  // scope options and confirmation copy read correctly for non-scripture
  // files. No active file (lane launch) ⇒ neutral wording.
  const activeFile = useMemo(
    () => (activeFileId ? projectFiles.find((f) => f.id === activeFileId) ?? null : null),
    [activeFileId, projectFiles],
  )
  const isScripture = activeFile ? SCRIPTURE_FILE_TYPES.has(activeFile.type) : false
  const sectionNoun = isScripture
    ? t("editor.milestone.vocab.chapterPlural")
    : t("editor.milestone.vocab.sectionPlural")
  // AQU-511 wave 4: the chapter/section wording is chosen by picking a whole
  // translated sentence, not by substituting a translated noun into one. A noun
  // interpolated into another language's sentence cannot agree with it.
  const loadingUnitsKey = isScripture
    ? ("dialog.assign.loadingChapters" as const)
    : ("dialog.assign.loadingSections" as const)
  const noUnitsFoundKey = isScripture
    ? ("dialog.assign.noChaptersFound" as const)
    : ("dialog.assign.noSectionsFound" as const)
  const selectUnitErrorKey = isScripture
    ? ("dialog.assign.error.selectChapter" as const)
    : ("dialog.assign.error.selectSection" as const)
  const segmentNoun = isScripture ? "verse" : "segment"
  const wholeFileLabel = isScripture
    ? t("dialog.assign.scope.allVerses")
    : t("dialog.assign.scope.entireFile")

  const scopeOptions: { value: ScopeKind; label: string }[] = [
    { value: "selection", label: t("dialog.assign.scope.selection") },
    { value: "verses", label: wholeFileLabel },
    { value: "chapters", label: sectionNoun },
    { value: "books", label: t("dialog.assign.scope.books") },
  ]

  // AQU-676: the assignee picker must list only the project's own members,
  // never everyone with org-baseline access. Org members inherit access to
  // every project via AD-12 max-wins, so without this filter a per-team mentor
  // doing assignments sees (and could assign to) other language teams' people.
  // partitionMembers (AQU-454) keeps only members with a project-specific path
  // (override / group / creator); org-baseline-only members drop out.
  const eligibleMembers = useMemo(
    () => partitionMembers(members).projectMembers,
    [members],
  )

  // AQU-497: group the books-scope file list by corpusMarker (real season/
  // testament grouping — see file banner) so a whole season can be selected
  // in one click via the per-group "Select all".
  const fileGroups = useMemo(() => groupByCorpus(projectFiles), [projectFiles])

  // AQU-538 (§3.5): lane options — the default lane ('') first, then each extra
  // lane. Only rendered (length > 1) when the project actually has extra lanes,
  // keeping N=1 projects byte-identical to the pre-lane flow.
  const laneItems = useMemo(() => {
    const extra = targetLanes ?? []
    if (extra.length === 0) return [] as { value: string; label: string }[]
    // AQU-728: the '' lane IS a real language — the project's own default
    // target language. Label it with that language's name (e.g. "Portuguese")
    // so every lane, including the default, is listed by name and preselecting
    // the launching default lane reads as the language, not "default". Only
    // fall back to the generic label when the default language is unknown.
    const defaultLabel = defaultLaneLabel?.trim() || t("dialog.assign.defaultLaneFallback")
    return [
      { value: "", label: defaultLabel },
      ...extra.map((lane) => ({ value: lane, label: lane })),
    ]
  }, [targetLanes, defaultLaneLabel, t])
  // fileId -> named group label (excludes the synthetic "Ungrouped" bucket),
  // used to prefix each bulk-created assignment's scopeLabel so a PM can see
  // which season an individually-removable row came from.
  const groupLabelByFileId = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of fileGroups) {
      if (group.label === "Ungrouped") continue
      for (const f of group.files) map.set(f.id, group.label)
    }
    return map
  }, [fileGroups])

  const toggleFileGroup = useCallback((fileIds: string[]) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      const allSelected = fileIds.every((id) => next.has(id))
      for (const id of fileIds) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])

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
    if (!member) { setError(t("dialog.assign.error.selectMember")); return }

    // AQU-676 defense-in-depth: org-baseline-only members are not assignable —
    // only the project's own members. The picker already hides them (see
    // eligibleMembers), but re-check on submit so a stale/forced selection
    // can't route an assignment to someone outside the project. Self-assign
    // mode is exempt: the caller is claiming work for themselves.
    if (
      !isSelfAssignMode &&
      !eligibleMembers.some((m) => m.userId === member.userId)
    ) {
      setError(t("dialog.assign.error.notProjectMember"))
      return
    }

    // AQU-496 defense-in-depth: re-check even though the picker is already
    // locked to self in self-assign mode — the server is authoritative and
    // will 403 regardless, but this avoids a round-trip for the obvious case.
    if (!canSubmitAssignment(roleLevel, allowSelfAssignment, callerUserId, member.userId)) {
      setError(t("dialog.assign.error.selfOnly"))
      return
    }

    const deadline = deadlineDate ? dateToDeadlineString(deadlineDate) : null

    // AQU-497: books scope is a bulk (one-per-file) assignment — handled
    // separately since it emits N events, not one, and reports partial
    // failure per-file rather than an all-or-nothing error.
    if (scopeKind === "books") {
      if (selectedFileIds.size === 0) { setError(t("dialog.assign.error.selectFile")); return }
      const entries = Array.from(selectedFileIds).map((fid) => {
        const name = projectFiles.find((f) => f.id === fid)?.name ?? fid
        const groupLabel = groupLabelByFileId.get(fid)
        return { fileId: fid, scopeLabel: groupLabel ? `${groupLabel} · ${name}` : name }
      })
      setSubmitting(true)
      try {
        const results = await createBulkFileAssignments({
          jwt,
          projectId,
          author,
          assigneeUserId: member.userId,
          entries,
          targetLang: selectedLane || undefined,
          deadline,
          note: note.trim() || null,
        })
        const failed = results.filter((r) => r.error)
        const succeeded = results.length - failed.length
        if (succeeded > 0) onAssigned()
        if (failed.length > 0) {
          setError(
            t("dialog.assign.error.bulkFailed", {
              failed: String(failed.length),
              total: String(results.length),
            }) +
            (succeeded > 0
              ? t("dialog.assign.error.bulkSucceededSuffix", { succeeded: String(succeeded) })
              : "") +
            `: ${failed[0].error}`,
          )
        } else {
          onOpenChange(false)
        }
      } finally {
        setSubmitting(false)
      }
      return
    }

    // Build scope + scopeLabel for the single-event scopes.
    let scope: { fileId: string; chapter?: string }[] = []
    let scopeLabel = ""
    let apiScopeKind: "books" | "chapters" = "books"

    if (scopeKind === "selection" || scopeKind === "verses") {
      if (!activeFileId) { setError(t("dialog.assign.error.noFileOpen")); return }
      const file = projectFiles.find((f) => f.id === activeFileId)
      const fileName = file?.name ?? activeFileId
      scope = [{ fileId: activeFileId }]
      // Persisted scope-label data (stored on the assignment record), not a
      // rendered UI string — left in English; see AQU-511 dialog namespace notes.
      scopeLabel = scopeKind === "selection"
        ? `${selectedCellIds.size} ${segmentNoun}(s) in ${fileName}`
        : isScripture
          ? `All verses in ${fileName}`
          : `Entire ${fileName}`
      apiScopeKind = "books"
    } else if (scopeKind === "chapters") {
      if (!activeFileId) { setError(t("dialog.assign.error.noFileOpen")); return }
      if (selectedChapters.size === 0) {
        setError(t(selectUnitErrorKey))
        return
      }
      const file = projectFiles.find((f) => f.id === activeFileId)
      scope = Array.from(selectedChapters).map((ch) => ({ fileId: activeFileId, chapter: ch }))
      scopeLabel = `${Array.from(selectedChapters).join(", ")} in ${file?.name ?? activeFileId}`
      apiScopeKind = "chapters"
    }

    // Use activeFileId as the routing file for the event token.
    const routeFileId = activeFileId ?? scope[0]?.fileId
    if (!routeFileId) { setError(t("dialog.assign.error.noRouteFile")); return }

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
        targetLang: selectedLane || undefined,
        deadline,
        note: note.trim() || null,
      })
      onAssigned()
      onOpenChange(false)
    } catch (e) {
      if (e instanceof AssignmentEmitError) {
        setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : t("dialog.assign.error.unknown"))
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    members, eligibleMembers, isSelfAssignMode, selectedMemberId, scopeKind, activeFileId, projectFiles,
    selectedCellIds.size, selectedChapters, selectedFileIds,
    jwt, projectId, author, note, onAssigned, onOpenChange,
    roleLevel, allowSelfAssignment, callerUserId, deadlineDate, groupLabelByFileId,
    selectedLane, isScripture, segmentNoun, selectUnitErrorKey, t,
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
        .map((m) => ({
          value: String(m.userId),
          label: t("dialog.assign.assigneeSelfSuffix", { username: m.username }),
        }))
    : [
        { value: "", label: t("dialog.assign.selectMemberPlaceholder") },
        // AQU-676: project members only — org-baseline-only people are excluded.
        ...eligibleMembers.map((m) => ({ value: String(m.userId), label: m.username })),
      ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-4 w-4" />
            {t("dialog.assign.title")}
          </DialogTitle>
        </DialogHeader>

        {/* Scroll region: header + footer stay fixed while a tall body (e.g. a
            large Files/Books list) scrolls, instead of overflowing the clipped
            max-h-[85dvh] DialogContent. */}
        <DialogBody>
        <FieldGroup className="py-1">
          <Field>
            <FieldLabel htmlFor="assign-modal-scope">{t("dialog.assign.scopeLabel")}</FieldLabel>
            <Select
              items={scopeOptions.map((opt) => ({
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
                  {scopeOptions.map((opt) => {
                    // AQU-658: scopes that need the open editor file are
                    // disabled when the modal is launched from a lane (no
                    // active file); only "books" (file picker) works there.
                    const disabled =
                      (opt.value === "selection" && selectedCellIds.size === 0) ||
                      (ACTIVE_FILE_SCOPES.has(opt.value) && !activeFileId)
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

          {/* AQU-538 (§3.5): lane select — only when the project has extra
              lanes. Assigning routes WORK to a lane; it is not a permission
              wall (that's a scope — see §3.5). */}
          {laneItems.length > 1 && (
            <Field>
              <FieldLabel htmlFor="assign-modal-lane">{t("dialog.assign.laneLabel")}</FieldLabel>
              <Select
                items={laneItems}
                value={selectedLane}
                onValueChange={(v) => setSelectedLane(v ?? "")}
              >
                <SelectTrigger id="assign-modal-lane" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {laneItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t("dialog.assign.laneDescription")}</FieldDescription>
            </Field>
          )}

          {scopeKind === "books" && (
            <Field>
              <FieldLabel>{t("dialog.assign.filesLabel")}</FieldLabel>
              <FieldDescription>{t("dialog.assign.filesDescription")}</FieldDescription>
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
                {fileGroups.map((group) => {
                  const groupFileIds = group.files.map((f) => f.id)
                  const allSelected = groupFileIds.every((id) => selectedFileIds.has(id))
                  return (
                    <div key={group.label}>
                      <div className="flex items-center justify-between px-1 py-0.5">
                        <span className="text-xs font-medium text-muted-foreground">{group.label}</span>
                        {group.label !== "Ungrouped" && groupFileIds.length > 1 && (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => toggleFileGroup(groupFileIds)}
                          >
                            {allSelected ? t("common.clear") : t("common.selectAll")}
                          </button>
                        )}
                      </div>
                      {group.files.map((f) => (
                        <label key={f.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50">
                          <Checkbox
                            checked={selectedFileIds.has(f.id)}
                            onCheckedChange={() => toggleFile(f.id)}
                            className="size-3"
                          />
                          {f.name}
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            </Field>
          )}

          {scopeKind === "chapters" && (
            <Field>
              <FieldLabel>{sectionNoun}</FieldLabel>
              {chaptersLoading ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  {t(loadingUnitsKey)}
                </div>
              ) : availableChapters.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(noUnitsFoundKey)}
                </p>
              ) : (
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2">
                  {availableChapters.map((ch) => (
                    <label key={ch} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50">
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
            <FieldLabel htmlFor="assign-modal-assignee">{t("dialog.assign.assigneeLabel")}</FieldLabel>
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
              <FieldDescription>{t("dialog.assign.selfAssignDescription")}</FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="assign-modal-deadline">{t("dialog.assign.deadlineLabel")}</FieldLabel>
            <DatePicker
              id="assign-modal-deadline"
              value={deadlineDate}
              onChange={setDeadlineDate}
              disabled={submitting}
            />
            {scopeKind === "books" && (
              <FieldDescription>{t("dialog.assign.deadlineBatchDescription")}</FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="assign-modal-note">{t("dialog.assign.noteLabel")}</FieldLabel>
            <Textarea
              id="assign-modal-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="resize-none"
              placeholder={t("dialog.assign.notePlaceholder")}
            />
          </Field>

          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Spinner className="mr-1" /> : null}
            {t("dialog.assign.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
