/**
 * Moving projects between folders on People & access, the way files move in
 * a file manager: drag a project onto a folder (or onto the organization, to
 * take it out of every folder), or pick the destination from the project's
 * "Move to" menu (ProjectMove.tsx). Afterwards the project is in exactly that
 * folder, and a toast offers Undo.
 *
 * A move changes who can open the project: the folder it leaves stops giving
 * its people access and the folder it enters starts (planProjectMove). Only
 * org Maintainers and Owners may move, the rule the team routes apply.
 */
import { useState, type DragEvent } from "react"

import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { placeParam } from "@/lib/access/place-lens"
import type { ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { planProjectMove, projectAttachments, projectShownIn, undoMovePlan, type FolderNode } from "./folder-tree"
import { applyProjectMove } from "./move-project-data"

/** The role a folder gives its people on a project that was in no folder (the server's attach default, Viewer). */
const DEFAULT_FOLDER_ROLE = 100
const DRAG_TYPE = "application/x-aquilla-project"

/** Where a project can go: the organization itself (`id` null) or one of its folders. */
export interface MoveDestination {
  id: string | null
  scope: ScopeRef
}

/** The organization and the folders directly in it, in tree order. */
export function moveDestinations(folders: readonly FolderNode[]): MoveDestination[] {
  return folders.flatMap((root) =>
    root.node.scope.type === "org"
      ? [
          { id: null, scope: root.node.scope },
          ...root.children.filter((c) => c.node.scope.type === "team").map((c) => ({ id: c.node.scope.id, scope: c.node.scope })),
        ]
      : [],
  )
}

export function useProjectMove({ orgId, enabled, onChanged }: { orgId: number; enabled: boolean; onChanged: () => void }) {
  const t = useT()
  const { session } = useFrontierSession()
  const [dragging, setDragging] = useState<FolderNode | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)

  const move = async (project: FolderNode, to: MoveDestination) => {
    const jwt = session?.jwt
    if (!jwt || !enabled || moving) return
    const attachments = projectAttachments(project.node)
    const plan = planProjectMove(attachments, projectShownIn(project), to.id, DEFAULT_FOLDER_ROLE)
    if (!plan) return
    const projectId = project.node.scope.id
    const name = project.node.scope.name
    setMoving(placeParam(project.node.scope))
    try {
      await applyProjectMove(jwt, orgId, projectId, plan)
      toast.add({
        type: "success",
        // Long enough to read and undo: a move changes who can open the project.
        timeout: 10_000,
        title: t("org.access.tree.moved", { project: name, place: to.scope.name }),
        actionProps: {
          children: t("editor.history.undoThis"),
          onClick: () => {
            void applyProjectMove(jwt, orgId, projectId, undoMovePlan(attachments, plan))
              .catch(() => toast.add({ type: "error", title: t("org.access.tree.moveFailed", { project: name }) }))
              .finally(onChanged)
          },
        },
      })
    } catch {
      toast.add({ type: "error", title: t("org.access.tree.moveFailed", { project: name }) })
    } finally {
      setMoving(null)
      onChanged()
    }
  }

  /** On a project row: makes it draggable. */
  const dragSource = (project: FolderNode) =>
    enabled && project.node.scope.type === "project"
      ? {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = "move"
            event.dataTransfer.setData(DRAG_TYPE, project.node.scope.id)
            setDragging(project)
          },
          onDragEnd: () => {
            setDragging(null)
            setDropTarget(null)
          },
        }
      : {}

  /** On the organization row and each folder row: accepts a dragged project. */
  const dropTargetProps = (target: MoveDestination | null) => {
    if (!target || !dragging) return { isTarget: false, props: {} }
    const key = placeParam(target.scope)
    const changes = planProjectMove(projectAttachments(dragging.node), projectShownIn(dragging), target.id, DEFAULT_FOLDER_ROLE) != null
    return {
      isTarget: dropTarget === key,
      props: changes
        ? {
            onDragOver: (event: DragEvent) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              if (dropTarget !== key) setDropTarget(key)
            },
            onDragLeave: (event: DragEvent) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
            },
            onDrop: (event: DragEvent) => {
              event.preventDefault()
              const project = dragging
              setDragging(null)
              setDropTarget(null)
              void move(project, target)
            },
          }
        : {},
    }
  }

  return {
    enabled,
    dragging: dragging ? placeParam(dragging.node.scope) : null,
    moving,
    move,
    dragSource,
    dropTargetProps,
  }
}

