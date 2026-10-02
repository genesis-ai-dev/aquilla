// LinkSourceFlow — the link-an-established-project flow itself, with no chrome
// of its own.
//
// Extracted from LinkSourceSection (AQU-1525) when the Import dialog gained a
// "From another project" tile (AQU-1527). Both entry points reach the same
// action — pick an upstream the user can access, review what the link will add,
// confirm — so both mount this one component. The alternative was a second copy
// of the picker, the AQU-1526 confirm step, the cycle refusal and the seed
// self-heal, which would diverge on the first change to any of them; the issue's
// own acceptance criterion says the two entry points never diverge.
//
// What stays with the caller is only the frame: settings wraps this in the
// "Link to a source project" Card, the Import dialog renders it as a screen with
// the dialog's own back control. Nothing here knows which one it is in.
//
// The behaviour, unchanged from AQU-1525/AQU-1526:
//
// The server-side link action (POST /api/v2/projects/:id/link-source,
// auth-worker routes/source-linking.ts) has always accepted an *established*
// project — it only needs project_lead(500)+ on this project plus some access to
// the upstream, and it refuses a self-link or a cycle itself. Until AQU-1525 the
// only caller was ProjectCreateDialog, so a project created without a link had
// no way in and the workaround was to delete and rebuild it (hit on a Biblica
// setup call, five projects deep).
//
// Linking posts mode='live' (a one-time clone is deliberately not on the menu
// here) plus the corpus the user picks:
//
// AQU-1528: until this slice the flow hard-coded consumes='source' — Create New
// Project → Linked target → "Its Source". That left the CHAIN case (this
// project translates one of the upstream's translations, e.g. French → Chaluba)
// reachable only while creating a project, so a team that wanted it on a
// project they already had was back to deleting and rebuilding it — the exact
// workaround AQU-1010 exists to remove. So the flow now asks the same question
// the create modal asks, "Which corpus should become this project's source?",
// and posts the answer.
//
// The wording is shared by reusing the create modal's own catalog keys
// (`projectSettings.create.linkConsumes*`) rather than copying the sentences:
// the acceptance criterion is that the two read identically, and a copy would
// drift on the first edit to either. `gate` is left off the request on purpose
// — the route defaults it to 'validated' (auth-worker routes/source-linking.ts),
// which is both what creation sends and the "only validated upstream
// translations flow through" behaviour the chain case is specified to have.
//
// Linking is ADDITIVE: the server seeds the upstream's source cells alongside
// whatever this project already holds, so existing files, translations and
// validation state are untouched. A file sharing a name with an upstream file is
// allowed and simply appears twice.
//
// AQU-1526: because that duplicate is the COMMON case — an established project
// is usually being linked precisely because it already holds some of the same
// material — picking an upstream no longer links it. It opens a confirm step
// that first says what the link will bring in: the upstream's name, how many
// files arrive, and any upstream file whose name collides with one already here.
// The warning does not block; confirming still links.
//
// AQU-1559: the confirm step is also where the lead picks WHICH of the
// upstream's files to follow. Every file arrives checked, so the default is the
// whole-project link the flow has always made; unchecking any of them makes the
// link a fixed list instead, and the request carries the picked upstream file
// ids. Everything the step already said follows the selection — the count
// sentence and the same-name warning both read the checked rows, because a file
// that is not coming cannot clash with anything.
//
// AQU-1561: the list, its check-all control and its wording are now
// `UpstreamFileChoiceList`, shared with Create New Project, which asks the
// same question when a project is created from an upstream. The two must not
// drift apart, so neither owns the markup.
//
// The two outcomes are deliberately different products, not a cosmetic
// difference (Matthew, 2026-10-02): a whole-project link keeps receiving files
// the upstream gains later, a fixed-list one does not. That distinction lives in
// what this component sends — `fileIds` omitted vs. present — and the server
// stores it verbatim (auth-worker routes/source-linking.ts).
//
// AQU-1544: saving the link and bringing the files in are two steps, and only
// the first is the link request. When the server reports its seed did not run
// the flow retries once itself; until this slice it then ignored whether that
// retry worked and reported success either way, so a failed first sync closed
// the Import dialog and flipped the settings card exactly as a good one does.
// Now a failed retry is its own end state: the flow shows that the link is
// saved, that the files have not arrived, and a "Try again" — and `onLinked`
// does not fire until the files are actually in.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ProjectCombobox } from "@/components/ProjectCombobox"
import { UpstreamFileChoiceList } from "@/components/UpstreamFileChoiceList"
import { LinkSeedFailedNotice } from "@/components/LinkSeedFailedNotice"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { ROLE } from "@/lib/frontier/roles"
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import {
  selectedClashNames,
  summarizeFileSelection,
} from "@/lib/sync/link-file-selection"
import {
  loadLinkSourcePreview,
  type LinkSourcePreview,
} from "@/lib/sync/link-source-preview"
import { markLinkSeedFailed } from "@/lib/sync/link-seed-status"
import { announceProjectRecordChanged } from "@/lib/sync/project-record-changed"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

/**
 * Which corpus of the upstream becomes this project's source. `""` is "not
 * answered yet" — never a default, because the two outcomes are different
 * products and guessing one would silently build the wrong chain.
 */
type LinkConsumes = "" | "source" | "target"

export interface LinkSourceFlowProps {
  projectId: string
  /**
   * Called once the link is saved AND the upstream's files are in, so the host
   * can refresh the project record. AQU-1544: not called while the first sync
   * is still failing — the flow keeps the screen and offers a retry instead.
   */
  onLinked: () => void
  /**
   * AQU-1544: the link is saved but its first sync failed. For a host that
   * outlives the flow and tracks whether the project is linked (the workspace
   * behind the Import dialog), so it stops offering to link a project that
   * already is. The flow is NOT finished — do not close on this.
   */
  onLinkSavedWithoutFiles?: () => void
  /**
   * The host's "why you would link" sentence, shown above every step that
   * still offers to link. It is passed in rather than rendered by the host so
   * the flow can drop it once the link is saved (AQU-1544): "this project owns
   * its own source — link it" directly above "the link was saved" contradicts
   * itself.
   */
  intro?: ReactNode
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
}

export function LinkSourceFlow({
  projectId,
  onLinked,
  onLinkSavedWithoutFiles,
  intro,
  roleLevel,
}: LinkSourceFlowProps) {
  const t = useT()
  const { session } = useFrontierSession()
  // project_lead is the floor the link route enforces, so it is also what
  // decides whether this is a picker or a sentence. Callers that gate their own
  // entry point (the Import dialog's tile) read the same ROLE constant.
  const canLink = (roleLevel ?? 0) >= ROLE.PROJECT_LEAD

  // Viewer+ (no minRole), so the picker offers every project the user can
  // reach — including ones they did not create and ones where they are only a
  // Viewer, which is exactly the access the server requires of the upstream.
  // Only fetched when the user could actually link; a Contributor's card is a
  // sentence, not a picker.
  const { projects, isLoading, error: projectsError } = useProjectsForNavigation(canLink)

  const [chosen, setChosen] = useState("")
  // AQU-1528: deliberately unset until the user answers. Kept across a change
  // of upstream (the question is about the corpus, not the project), and reset
  // after a successful link so a re-link following a Detach asks again.
  const [consumes, setConsumes] = useState<LinkConsumes>("")
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // AQU-1544: the link request succeeded but neither the server's seed nor
  // this flow's own retry brought the files in. Terminal for the picker — the
  // project is linked now, so offering to pick again would be wrong — and
  // cleared only by a retry that works.
  const [seedFailed, setSeedFailed] = useState(false)

  // AQU-1526: the id under review in the confirm step. Separate from `chosen`
  // so backing out of the confirm step returns to the picker with the pick
  // still in it, and so the preview below is only ever fetched for a pick the
  // user has actually asked to review.
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [preview, setPreview] = useState<LinkSourcePreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  // AQU-1559: the upstream file ids still checked. Seeded with every file the
  // moment the preview lands — arriving all-checked is what keeps the default
  // outcome the whole-project link this flow has always made — and dropped when
  // the step is left, so re-entering it starts from all-checked again rather
  // than from a stale pick (possibly of a different upstream's files).
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  // Bumped by "Try again" so the effect re-runs for the same upstream.
  const [previewAttempt, setPreviewAttempt] = useState(0)

  // Never offer this project itself (the server 400s on a self-link), and
  // never an archived one.
  const options = useMemo(
    () =>
      projects
        .filter((p) => !p.archivedAt && p.id !== projectId)
        .map((p) => ({ id: p.id, name: p.name })),
    [projects, projectId],
  )

  const jwt = session?.jwt

  // The upstream's name from the picker is the fallback heading while the
  // preview loads or after it fails — the confirm step must name the project
  // even when its file list could not be read.
  const reviewingName = useMemo(
    () => options.find((o) => o.id === reviewing)?.name ?? "",
    [options, reviewing],
  )

  useEffect(() => {
    if (!reviewing || !jwt) return
    let cancelled = false
    // No reset needed on entry: `reviewing` only ever goes null → an id (the
    // picker is the one caller, and it is only on screen while `reviewing` is
    // null), and both backToPicker and the retry handler clear these first.
    void loadLinkSourcePreview(jwt, projectId, reviewing)
      .then((result) => {
        if (cancelled) return
        setPreview(result)
        setSelectedFileIds(new Set(result.files.map((f) => f.id)))
      })
      .catch(() => {
        // The message is a fixed sentence, not the server's: a count the user
        // cannot see is the whole failure, and "nothing has been linked" is the
        // part that needs saying. Retry is a button, not a reload.
        if (!cancelled) setPreviewFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [reviewing, jwt, projectId, previewAttempt])

  const backToPicker = useCallback(() => {
    setReviewing(null)
    setPreview(null)
    setPreviewFailed(false)
    setSelectedFileIds(new Set())
    setError(null)
  }, [])

  const toggleFile = useCallback((fileId: string) => {
    setSelectedFileIds((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  // AQU-1559: what the confirm step says and sends, all read off the checked
  // rows. `previewFiles` is empty both before the preview lands and for an
  // upstream with no files — neither shows a list, and only the second links.
  // Memoized so the folds below are not re-run on every render by a fresh array
  // identity (and so the React Compiler sees a stable dependency).
  //
  // AQU-1561: the folds moved to `lib/sync/link-source-preview.ts`, beside the
  // row type they read, and the list itself to `UpstreamFileChoiceList`, which
  // Create New Project renders too — the two flows ask the same question and
  // must keep answering it the same way.
  const previewFiles = useMemo(() => preview?.files ?? [], [preview])
  const { selectedCount, allSelected: allFilesSelected, nothingSelected } = useMemo(
    () => summarizeFileSelection(previewFiles, selectedFileIds),
    [previewFiles, selectedFileIds],
  )
  // Only the clashes still coming: unchecking a clashing file removes it from
  // the warning, and with no checked clash left the warning is gone.
  const clashNames = useMemo(
    () => selectedClashNames(previewFiles, selectedFileIds),
    [previewFiles, selectedFileIds],
  )

  async function handleLink() {
    // AQU-1526: the upstream under review, not the picker's value — what gets
    // linked is exactly what the preview above described.
    // `consumes` cannot be empty here — the review button is gated on it — but
    // the guard keeps the request from ever defaulting the corpus silently.
    if (!reviewing || !consumes || !jwt || linking) return
    // AQU-1559: guarded as well as disabled — the request must never be able to
    // save a link that follows nothing.
    if (nothingSelected) return
    setLinking(true)
    setError(null)
    try {
      const result = await linkProjectSource(jwt, projectId, {
        sourceProjectId: reviewing,
        mode: "live",
        consumes,
        // AQU-1559: every file left checked means "follow the whole project" —
        // the request omits the list entirely, so the upstream's later files
        // keep arriving, exactly as before this slice. A subset sends the picked
        // ids, which pins the link to them. An empty upstream has nothing to
        // pick and is a whole-project link by the same rule.
        ...(allFilesSelected || previewFiles.length === 0
          ? {}
          : { fileIds: [...selectedFileIds] }),
      })
      // AQU-476/QA-BUG-1: the server seeds inside the same call; `false` means
      // that trigger did not run, so self-heal before the user sees an empty
      // file list. Same fallback ProjectCreateDialog does.
      // AQU-1544: and when the self-heal fails too, say so. The link is saved
      // server-side at this point, so this is not the catch below's "still
      // unlinked, pick again" — it is "linked, files missing, try again".
      const seeded = result.seeded !== false || (await triggerLinkSync(jwt, projectId))
      setChosen("")
      setConsumes("")
      setReviewing(null)
      setPreview(null)
      setSelectedFileIds(new Set())
      if (!seeded) {
        // Parked for the page behind this flow too: an Import dialog dismissed
        // from here must not leave the workspace looking healthy.
        markLinkSeedFailed(projectId)
        setSeedFailed(true)
        onLinkSavedWithoutFiles?.()
        return
      }
      // AQU-1570: `onLinked` refreshes the HOST's copy of the project. The page
      // behind Project Settings holds its own, and it is the one showing the
      // file list the upstream's files just landed in.
      announceProjectRecordChanged(projectId)
      onLinked()
    } catch (err) {
      const facing = toUserFacingError(err, "project")
      // 409 is the route's cycle refusal and nothing else, so name the loop
      // rather than showing the generic "conflict" sentence. The project is
      // left unlinked server-side either way, so the picker keeps its choice
      // and the button stays live for a retry.
      setError(
        facing.status === 409
          ? t("projectSettings.linkSource.cycleError")
          : facing.message,
      )
    } finally {
      setLinking(false)
    }
  }

  if (!canLink) {
    return (
      <>
        {intro}
        <p className="text-xs text-muted-foreground">
          {t("projectSettings.linkSource.roleGateNote")}
        </p>
      </>
    )
  }

  if (seedFailed) {
    // ── AQU-1544: linked, but the upstream's files are not here ──
    return (
      <LinkSeedFailedNotice
        projectId={projectId}
        onSynced={() => {
          setSeedFailed(false)
          onLinked()
        }}
      />
    )
  }

  if (reviewing) {
    // ── AQU-1526 confirm step: what the link will add, before it does ──
    return (
      <>
        {intro}
        <p className="text-sm font-medium">
          {t("projectSettings.linkSource.previewTitle", {
            upstream: preview?.upstreamName || reviewingName,
          })}
        </p>
        {previewFailed ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              {t("projectSettings.linkSource.previewLoadError")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPreviewFailed(false)
                setPreviewAttempt((n) => n + 1)
              }}
            >
              {t("projectSettings.linkSource.previewRetryButton")}
            </Button>
          </div>
        ) : !preview ? (
          <p className="text-sm text-muted-foreground">
            {t("projectSettings.linkSource.previewLoading")}
          </p>
        ) : (
          <>
            {/* AQU-1559: the list is what makes the count a choice rather than
                an announcement. Rows are the upstream's own order, scrolled
                rather than paged — an upstream can hold 66 books or more, and a
                lead unchecking three of them should not have to hunt pages. */}
            <UpstreamFileChoiceList
              files={previewFiles}
              selectedFileIds={selectedFileIds}
              onToggleFile={toggleFile}
              onToggleAll={(checked) =>
                setSelectedFileIds(
                  checked ? new Set(previewFiles.map((f) => f.id)) : new Set(),
                )
              }
            />
            <p className="text-sm" role={nothingSelected ? "alert" : undefined}>
              {previewFiles.length === 0
                ? t("projectSettings.linkSource.previewEmptyUpstream")
                : nothingSelected
                  ? t("projectSettings.linkSource.previewNoneSelected")
                  : t("projectSettings.linkSource.previewCount", {
                      count: selectedCount,
                    })}
            </p>
            {/* AQU-1559: a whole-project link keeps picking up the upstream's
                later files; a subset one does not. Said here because it is the
                part of the outcome the checkboxes alone do not show. */}
            {!nothingSelected && (
              <p className="text-xs text-muted-foreground">
                {allFilesSelected || previewFiles.length === 0
                  ? t("projectSettings.linkSource.scopeAllNote")
                  : t("projectSettings.linkSource.scopeSubsetNote")}
              </p>
            )}
            {/* The clash is a warning, never a refusal: the confirm
                button below stays live beside it. */}
            {clashNames.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <p>
                    {t("projectSettings.linkSource.clashWarningHeading", {
                      count: clashNames.length,
                    })}
                  </p>
                  <ul className="list-inside list-disc font-medium">
                    {clashNames.map((name) => (
                      <li key={name.toLowerCase()}>{name}</li>
                    ))}
                  </ul>
                  <p>
                    {t("projectSettings.linkSource.clashWarningBody", {
                      count: clashNames.length,
                    })}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
        {/* AQU-1528: the confirm step has to say WHICH corpus is about to
            become this project's source — the file count alone reads the same
            for either answer. These are the badge strings SourceLinkSection
            shows once the link exists, so the before and after match. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {consumes === "target"
              ? t("projectSettings.sourceLink.consumesTranslations")
              : t("projectSettings.sourceLink.consumesSource")}
          </Badge>
          {consumes === "target" && (
            <Badge variant="outline">
              {t("projectSettings.sourceLink.gateLabel", {
                value: t("projectSettings.sourceLink.gateValidatedOnly"),
              })}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("projectSettings.linkSource.additiveNote")}
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={linking} onClick={backToPicker}>
            {t("projectSettings.linkSource.cancelButton")}
          </Button>
          <Button
            size="sm"
            // AQU-1559: nothing checked, nothing to link — the sentence above
            // says so, and this is the control it refers to.
            disabled={linking || !session || previewFailed || nothingSelected}
            onClick={handleLink}
          >
            {linking
              ? t("projectSettings.linkSource.linkingButton")
              : t("projectSettings.linkSource.linkButton")}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {intro}
      <Field>
        <FieldLabel htmlFor="link-source-project">
          {t("projectSettings.linkSource.pickerLabel")}
        </FieldLabel>
        <ProjectCombobox
          id="link-source-project"
          options={options}
          value={chosen}
          onValueChange={(value) => {
            setChosen(value)
            setError(null)
          }}
          placeholder={t("projectSettings.linkSource.pickerPlaceholder")}
          searchPlaceholder={t("projectSettings.linkSource.pickerSearchPlaceholder")}
          searchAriaLabel={t("projectSettings.linkSource.pickerSearchAriaLabel")}
          emptyText={t("projectSettings.linkSource.pickerNoMatches")}
        />
      </Field>
      {/* Only once an upstream is on the table — the question is about THAT
          project's corpora, and the create modal gates it the same way. */}
      {chosen && (
        <Field>
          <FieldLabel>{t("projectSettings.create.linkConsumesLabel")}</FieldLabel>
          <RadioGroup
            // null = nothing selected (never prefill).
            value={consumes || null}
            onValueChange={(value) => {
              setConsumes((value ?? "") as LinkConsumes)
              setError(null)
            }}
            className="gap-2"
          >
            <label className="flex items-start gap-2.5 text-sm">
              <RadioGroupItem value="source" className="mt-0.5" />
              <span>
                <RichMessage
                  k="projectSettings.create.linkConsumesSource"
                  // The lane-count plural of this sentence governs a
                  // same-org recommendation ("a target lane … is" vs
                  // "target lanes … are"). An established project being
                  // linked has its lanes already and this flow never reads
                  // them, so it takes the singular form.
                  count={1}
                  values={{
                    name: <strong>{t("projectSettings.create.linkConsumesSourceName")}</strong>,
                  }}
                />
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-sm">
              <RadioGroupItem value="target" className="mt-0.5" />
              <span>
                <RichMessage
                  k="projectSettings.create.linkConsumesTarget"
                  values={{
                    name: <strong>{t("projectSettings.create.linkConsumesTargetName")}</strong>,
                  }}
                />
              </span>
            </label>
          </RadioGroup>
        </Field>
      )}
      {projectsError ? (
        <p className="text-sm text-destructive">{projectsError}</p>
      ) : (
        !isLoading &&
        options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.linkSource.noProjectsNote")}
          </p>
        )
      )}
      <p className="text-xs text-muted-foreground">
        {t("projectSettings.linkSource.additiveNote")}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button
          size="sm"
          // AQU-1528: no corpus answer, no way forward — and since the
          // confirm step is only reachable through here, the link action is
          // unavailable until one is chosen too.
          disabled={!chosen || !consumes || linking || !session}
          onClick={() => setReviewing(chosen)}
        >
          {t("projectSettings.linkSource.reviewButton")}
        </Button>
      </div>
    </>
  )
}
