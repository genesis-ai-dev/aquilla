// AQU-538 §3.2 — org-dashboard host for AssignModal, launched from a lane
// sub-row. Mounted only while a lane's "Assign…" is active (so its member
// fetch is lazy), it loads the project roster and renders AssignModal
// pre-scoped to the launching lane (defaultLane). Assigning routes WORK to a
// lane; it is not a permission wall (§3.5).

import { useMemo } from "react"
import type { FileType, FileReference } from "@/lib/parsers/types"
import { AssignModal } from "@/components/AssignModal"
import { useProjectMembers } from "@/hooks/useProjectMembers"

const EMPTY_SELECTION: ReadonlySet<string> = new Set()

export interface OrgLaneAssignModalProps {
  projectId: string
  /** The lane the modal was launched from ('' = default lane). */
  lane: string
  /** Extra (non-default) lane tags on the project — enables the lane select. */
  targetLanes: string[]
  /** Files in the project (for the books scope). May be empty when unknown. */
  files: { id: string; name: string }[]
  roleLevel: number
  jwt: string
  author: string
  allowSelfAssignment?: boolean
  callerUserId?: number | null
  onAssigned: () => void
  onClose: () => void
}

export function OrgLaneAssignModal({
  projectId,
  lane,
  targetLanes,
  files,
  roleLevel,
  jwt,
  author,
  allowSelfAssignment = false,
  callerUserId = null,
  onAssigned,
  onClose,
}: OrgLaneAssignModalProps) {
  const { members } = useProjectMembers(projectId)

  const projectFiles = useMemo<FileReference[]>(
    () =>
      files.map((f) => ({
        id: f.id,
        name: f.name,
        type: "unknown" as FileType,
        createdAt: "",
        cellCount: 0,
      })),
    [files],
  )

  return (
    <AssignModal
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      projectId={projectId}
      activeFileId={null}
      projectFiles={projectFiles}
      targetLanes={targetLanes}
      defaultLane={lane}
      members={members}
      roleLevel={roleLevel}
      allowSelfAssignment={allowSelfAssignment}
      callerUserId={callerUserId}
      selectedCellIds={EMPTY_SELECTION}
      jwt={jwt}
      author={author}
      onAssigned={onAssigned}
    />
  )
}
