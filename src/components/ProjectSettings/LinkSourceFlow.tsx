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
// Linking posts mode='live' / consumes='source' — the same shape as Create New
// Project → Linked target → "Its Source", which is the one outcome this flow
// offers (a one-time clone is deliberately not on the menu here).
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

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { ProjectCombobox } from "@/components/ProjectCombobox"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { ROLE } from "@/lib/frontier/roles"
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import {
  loadLinkSourcePreview,
  type LinkSourcePreview,
} from "@/lib/sync/link-source-preview"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LinkSourceFlowProps {
  projectId: string
  /** Called after a successful link so the host can refresh the project record. */
  onLinked: () => void
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
}

export function LinkSourceFlow({ projectId, onLinked, roleLevel }: LinkSourceFlowProps) {
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
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // AQU-1526: the id under review in the confirm step. Separate from `chosen`
  // so backing out of the confirm step returns to the picker with the pick
  // still in it, and so the preview below is only ever fetched for a pick the
  // user has actually asked to review.
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [preview, setPreview] = useState<LinkSourcePreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
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
        if (!cancelled) setPreview(result)
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
    setError(null)
  }, [])

  async function handleLink() {
    // AQU-1526: the upstream under review, not the picker's value — what gets
    // linked is exactly what the preview above described.
    if (!reviewing || !jwt || linking) return
    setLinking(true)
    setError(null)
    try {
      const result = await linkProjectSource(jwt, projectId, {
        sourceProjectId: reviewing,
        mode: "live",
        consumes: "source",
      })
      // AQU-476/QA-BUG-1: the server seeds inside the same call; `false` means
      // that trigger did not run, so self-heal before the user sees an empty
      // file list. Same fallback ProjectCreateDialog does.
      if (result.seeded === false) await triggerLinkSync(jwt, projectId)
      setChosen("")
      setReviewing(null)
      setPreview(null)
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
      <p className="text-xs text-muted-foreground">
        {t("projectSettings.linkSource.roleGateNote")}
      </p>
    )
  }

  if (reviewing) {
    // ── AQU-1526 confirm step: what the link will add, before it does ──
    return (
      <>
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
            <p className="text-sm">
              {preview.fileCount === 0
                ? t("projectSettings.linkSource.previewEmptyUpstream")
                : t("projectSettings.linkSource.previewCount", {
                    count: preview.fileCount,
                  })}
            </p>
            {/* The clash is a warning, never a refusal: the confirm
                button below stays live beside it. */}
            {preview.clashingNames.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <p>
                    {t("projectSettings.linkSource.clashWarningHeading", {
                      count: preview.clashingNames.length,
                    })}
                  </p>
                  <ul className="list-inside list-disc font-medium">
                    {preview.clashingNames.map((name) => (
                      <li key={name.toLowerCase()}>{name}</li>
                    ))}
                  </ul>
                  <p>
                    {t("projectSettings.linkSource.clashWarningBody", {
                      count: preview.clashingNames.length,
                    })}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
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
            disabled={linking || !session || previewFailed}
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
          disabled={!chosen || linking || !session}
          onClick={() => setReviewing(chosen)}
        >
          {t("projectSettings.linkSource.reviewButton")}
        </Button>
      </div>
    </>
  )
}
