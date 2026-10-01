// LinkSourceSection — AQU-1525 "Link to a source project" block in
// ProjectSettings → Source & sync.
//
// The missing entry point. The server-side link action
// (POST /api/v2/projects/:id/link-source, auth-worker
// routes/source-linking.ts) has always accepted an *established* project —
// it only needs project_lead(500)+ on this project plus some access to the
// upstream, and it refuses a self-link or a cycle itself. Until now the only
// caller was ProjectCreateDialog, so a project created without a link had no
// way in: SourceLinkSection renders only once `sourceProjectId` is set, and
// all it offers is Detach. People routinely create the project first and
// realise afterwards they should share a source; the only route was to delete
// and rebuild it (hit on a Biblica setup call, five projects deep).
//
// This card is the counterpart of SourceLinkSection: exactly one of the two
// shows, keyed off `sourceProjectId`. Linking posts mode='live' /
// consumes='source' — the same shape as Create New Project → Linked target →
// "Its Source", which is the one outcome this flow offers (a one-time clone is
// deliberately not on the menu here). On success the parent refreshes the
// project record, `sourceProjectId` lands, and this card is replaced by
// SourceLinkSection + the Upstream changes panel.
//
// Linking is ADDITIVE: the server seeds the upstream's source cells alongside
// whatever this project already holds, so existing files, translations and
// validation state are untouched. A file sharing a name with an upstream file
// is allowed and simply appears twice (the preview/warning for that is a
// follow-up slice, AQU-1526).

import { useMemo, useState } from "react"
import { Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { ProjectCombobox } from "@/components/ProjectCombobox"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LinkSourceSectionProps {
  projectId: string
  /** Called after a successful link so the parent can refresh the project record. */
  onLinked: () => void
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
}

const MIN_ROLE_LEVEL = 500 // project_lead

export function LinkSourceSection({ projectId, onLinked, roleLevel }: LinkSourceSectionProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const canLink = (roleLevel ?? 0) >= MIN_ROLE_LEVEL

  // Viewer+ (no minRole), so the picker offers every project the user can
  // reach — including ones they did not create and ones where they are only a
  // Viewer, which is exactly the access the server requires of the upstream.
  // Only fetched when the user could actually link; a Contributor's card is a
  // sentence, not a picker.
  const { projects, isLoading, error: projectsError } = useProjectsForNavigation(canLink)

  const [chosen, setChosen] = useState("")
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Never offer this project itself (the server 400s on a self-link), and
  // never an archived one.
  const options = useMemo(
    () =>
      projects
        .filter((p) => !p.archivedAt && p.id !== projectId)
        .map((p) => ({ id: p.id, name: p.name })),
    [projects, projectId],
  )

  async function handleLink() {
    const jwt = session?.jwt
    if (!chosen || !jwt || linking) return
    setLinking(true)
    setError(null)
    try {
      const result = await linkProjectSource(jwt, projectId, {
        sourceProjectId: chosen,
        mode: "live",
        consumes: "source",
      })
      // AQU-476/QA-BUG-1: the server seeds inside the same call; `false` means
      // that trigger did not run, so self-heal before the user sees an empty
      // file list. Same fallback ProjectCreateDialog does.
      if (result.seeded === false) await triggerLinkSync(jwt, projectId)
      setChosen("")
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

  return (
    <Card id="section-link-source">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.linkSource.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {t("projectSettings.linkSource.description")}
        </div>
        {canLink ? (
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
                onClick={handleLink}
              >
                {linking
                  ? t("projectSettings.linkSource.linkingButton")
                  : t("projectSettings.linkSource.linkButton")}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.linkSource.roleGateNote")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
