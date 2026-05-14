// Phase 5 / AD-9. Compact "Source: <name>" pill shown in the workspace
// header (or anywhere else that wants to surface "this project's source
// comes from upstream X").
//
// Renders nothing when the project isn't linked. When linked but the
// upstream name is unknown, falls back to "Source: linked upstream" —
// still informative.
//
// Click → navigates to the upstream project's workspace (read-only for
// most members, editable for users who also have project_lead+ there).

import { Link2 } from "lucide-react"
import { useNavigate } from "react-router-dom"

interface Props {
  /** The upstream project id, or null when not linked. */
  sourceProjectId: string | null
  /** Optional display name. */
  sourceProjectName?: string
  /** Read-only badge (non-clickable). Useful for surfaces where
   *  navigation would lose unsaved state. Default: false. */
  readonly?: boolean
  className?: string
}

export function SourceProjectBadge({
  sourceProjectId,
  sourceProjectName,
  readonly,
  className,
}: Props) {
  const navigate = useNavigate()
  if (!sourceProjectId) return null
  const label = sourceProjectName
    ? `Source: ${sourceProjectName}`
    : "Source: linked upstream"

  const base =
    "inline-flex items-center gap-1.5 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"

  const content = (
    <>
      <Link2 className="h-3 w-3" aria-hidden />
      <span className="truncate max-w-[16ch]">{label}</span>
    </>
  )

  if (readonly) {
    return (
      <span
        className={`${base} ${className ?? ""}`}
        title={sourceProjectName ?? "Linked to an upstream source project"}
        data-testid="source-project-badge"
      >
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => navigate(`/project/${sourceProjectId}`)}
      className={`${base} hover:bg-accent hover:text-foreground ${className ?? ""}`}
      title={`Open upstream source: ${sourceProjectName ?? sourceProjectId}`}
      data-testid="source-project-badge"
    >
      {content}
    </button>
  )
}
