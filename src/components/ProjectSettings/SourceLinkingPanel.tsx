// Phase 5 / AD-9. Project Settings card surfacing the source-link surface.
//
//   - Shows the current upstream (if any) with a button to detach.
//   - When unlinked, shows a button to link to a source project.
//   - Both actions are project_lead+ only; below that the buttons render
//     with a tooltip explaining why they're disabled.
//   - "Source-only" projects (no targetLanguage) are surfaced explicitly
//     with a downstream-targets count so the PM knows their canonical
//     source has consumers.
//
// Composes `useProjectSource` + `useDownstreamProjects` and the two
// dialogs. Other Project Settings sections do their own IDB writes;
// here all the mutation flows through the auth-worker.

import { useState } from "react"
import { ArrowUpRight, Link2, Unlink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useNavigate } from "react-router-dom"
import { useDownstreamProjects } from "@/hooks/useDownstreamProjects"
import { useProjectSource } from "@/hooks/useProjectSource"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { LinkSourceProjectDialog } from "@/components/LinkSourceProjectDialog"
import { DetachSourceProjectDialog } from "@/components/DetachSourceProjectDialog"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"

interface Props {
  projectId: string
  /** Caller's role on this project — used to gate link / detach. */
  roleLevel: number | null
  /** Initial source project id from the project record (if known). */
  initialSourceProjectId?: string | null
  initialSourceProjectName?: string
}

const PROJECT_LEAD = 500

export function SourceLinkingPanel({
  projectId,
  roleLevel,
  initialSourceProjectId,
  initialSourceProjectName,
}: Props) {
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const {
    sourceProjectId,
    sourceProjectName,
    isLinked,
    canEditLink,
    error,
    isMutating,
    link,
    detach,
  } = useProjectSource({
    projectId,
    roleLevel,
    initialSourceProjectId,
    initialSourceProjectName,
  })

  const { downstreams, refresh: refreshDownstreams } = useDownstreamProjects({
    projectId,
    getToken: () => jwt,
  })

  const [linkOpen, setLinkOpen] = useState(false)
  const [detachOpen, setDetachOpen] = useState(false)

  const hasLeadRole = (roleLevel ?? 0) >= PROJECT_LEAD
  const gateTooltip = hasLeadRole
    ? null
    : "Project Lead or higher can change the source link."

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          Source linking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLinked ? (
          <div className="space-y-2">
            <p className="text-sm">
              This project reads its source cells from{" "}
              <strong>{sourceProjectName || sourceProjectId}</strong>. Edits to
              the upstream's source automatically surface as a
              "source-updated" indicator on affected target cells.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => sourceProjectId && navigate(`/project/${sourceProjectId}`)}
              >
                <ArrowUpRight className="mr-1 h-3 w-3" />
                Open upstream
              </Button>
              <DisabledFieldTooltip
                disabled={!canEditLink}
                tooltip={gateTooltip}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDetachOpen(true)}
                  disabled={!canEditLink}
                >
                  <Unlink className="mr-1 h-3 w-3" />
                  Detach from source
                </Button>
              </DisabledFieldTooltip>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              This project is self-contained — it owns its source and its
              target sides. Linking to an upstream source project lets you
              draw source content from another project and inherit revisions
              automatically.
            </p>
            <DisabledFieldTooltip
              disabled={!canEditLink}
              tooltip={gateTooltip}
            >
              <Button
                size="sm"
                onClick={() => setLinkOpen(true)}
                disabled={!canEditLink}
              >
                <Link2 className="mr-1 h-3 w-3" />
                Link to source project
              </Button>
            </DisabledFieldTooltip>
          </div>
        )}

        {downstreams.length > 0 && (
          <div className="rounded border bg-muted/30 p-3">
            <p className="text-xs font-medium">
              {downstreams.length} linked target
              {downstreams.length === 1 ? "" : "s"} read{downstreams.length === 1 ? "s" : ""}{" "}
              from this project
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {downstreams
                .map((d) => d.name || d.id)
                .slice(0, 5)
                .join(", ")}
              {downstreams.length > 5 ? `, +${downstreams.length - 5} more` : ""}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Deleting or archiving this project will affect those translations.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>

      <LinkSourceProjectDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        projectId={projectId}
        isMutating={isMutating}
        error={error}
        onSubmit={async (srcId) => {
          const ok = await link(srcId)
          if (ok) refreshDownstreams()
          return ok
        }}
      />
      <DetachSourceProjectDialog
        open={detachOpen}
        onOpenChange={setDetachOpen}
        sourceProjectName={sourceProjectName}
        isMutating={isMutating}
        error={error}
        onConfirm={async () => {
          const result = await detach()
          if (result) refreshDownstreams()
          return result
        }}
      />
    </Card>
  )
}
