/**
 * The "Move to" button on a project row of People & access: the keyboard way
 * to do what dragging the row onto a folder does (useProjectMove).
 */
import { Check, FolderInput } from "lucide-react"

import { PLACE_ICON } from "@/components/access/place-icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useT } from "@/lib/i18n/I18nProvider"

import { projectShownIn, type FolderNode } from "./folder-tree"
import type { MoveDestination } from "./useProjectMove"

/** The "Move to" button on a project row: every destination, the current one ticked. */
export function MoveProjectMenu({
  project,
  destinations,
  onMove,
  disabled,
}: {
  project: FolderNode
  destinations: readonly MoveDestination[]
  onMove: (to: MoveDestination) => void
  disabled: boolean
}) {
  const t = useT()
  const current = projectShownIn(project)
  const label = t("org.access.tree.moveTo", { name: project.node.scope.name })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            disabled={disabled}
            className="opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
          />
        }
        aria-label={label}
        data-testid="folder-move"
      >
        <FolderInput aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {destinations.map((destination) => {
          const here = destination.id === current
          const Icon = PLACE_ICON[destination.scope.type]
          return (
            <DropdownMenuItem
              key={destination.id ?? "org"}
              disabled={here}
              onClick={() => onMove(destination)}
              data-testid={`move-to-${destination.id ?? "org"}`}
            >
              <Icon aria-hidden />
              <span className="flex-1 truncate">
                {destination.id == null ? t("org.access.tree.noFolder", { name: destination.scope.name }) : destination.scope.name}
              </span>
              {here && <Check aria-hidden />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
