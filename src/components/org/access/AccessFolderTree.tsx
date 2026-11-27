/**
 * People & access as one folder tree: the organization is the root folder,
 * folders (teams in the data) are optional subfolders, projects are folders
 * with source files and settings, and languages are the leaves. Every row
 * shows the people added there (FolderPeopleStack) and, where the viewer may
 * grant, an "add person" button (AddPersonPopover). Hovering a row shows a
 * "+" that makes something inside it: a folder or project in the
 * organization, a project in a folder, a language in a project. Projects
 * move between folders by drag and drop or a "Move to" menu (ProjectMove).
 * Access set on a row reaches everything inside it.
 */
import { useEffect, useMemo, useState } from "react"
import { ChevronRight, Plus } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { PLACE_ICON } from "@/components/access/place-icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { AppTooltip } from "@/components/ui/tooltip"
import { placeRows } from "@/lib/access/give-access"
import type { PlaceGrantability } from "@/lib/access/grant-rules"
import { filterPlaceTree, parsePlaceParam, placeParam } from "@/lib/access/place-lens"
import type { ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { accessNodeId } from "./access-anchors"
import { AddPersonPopover } from "./AddPersonPopover"
import { FolderPeopleStack, type FolderEditing, type Removing } from "./FolderPeopleStack"
import { accessFolders, newChildKinds, type FolderNode } from "./folder-tree"
import type { AccessTreeNode, OrgAccessPerson } from "./org-access-data"
import { MoveProjectMenu } from "./ProjectMove"
import { moveDestinations, useProjectMove, type MoveDestination } from "./useProjectMove"
import { RemoveAccessDialog } from "./RemoveAccessDialog"

const KIND_LABEL = {
  // "Organization" is onboarding.apiTokens.orgLabel (no new key for the same word).
  org: "onboarding.apiTokens.orgLabel",
  team: "org.access.tree.kindFolder",
  project: "org.access.scope.project",
  // The shared "Language" string; the row shows every kind in lower case.
  lane: "language.label",
} as const

/** A project at or above this role may add a language to it. */
const ADD_LANGUAGE_MIN_ROLE = 500

export interface AccessFolderTreeProps {
  tree: AccessTreeNode[]
  query: string
  orgId: number
  grantable: Record<string, PlaceGrantability> | undefined
  people: OrgAccessPerson[]
  viewerUsername: string | null
  /** After a grant was added, changed or removed. The page re-reads the tree. */
  onChanged: () => void
  /** Present when the viewer may make a project here; `folderId` is the folder it goes in. */
  onNewProject?: (folderId: number | null) => void
  /** Present when the viewer may make a folder in the organization. Resolves once it exists. */
  onNewFolder?: (name: string) => Promise<void>
  /** Opens the project's "Add language" form. */
  onNewLanguage: (projectId: string) => void
  /** The viewer may move projects between folders (org Maintainer or above). */
  canMoveProjects?: boolean
}

type ChildKind = "team" | "project" | "lane"

export function AccessFolderTree({
  tree,
  query,
  orgId,
  grantable,
  people,
  viewerUsername,
  onChanged,
  onNewProject,
  onNewFolder,
  onNewLanguage,
  canMoveProjects = false,
}: AccessFolderTreeProps) {
  const t = useT()
  const [params] = useSearchParams()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [removing, setRemoving] = useState<Removing | null>(null)
  // The organization a new folder is being named in, if any.
  const [namingFolderIn, setNamingFolderIn] = useState<string | null>(null)
  const folders = useMemo(() => accessFolders(filterPlaceTree(tree, query)), [tree, query])
  const rows = useMemo(() => new Map(placeRows(tree, grantable).map((row) => [row.key, row])), [tree, grantable])
  const usernames = useMemo(() => new Map(people.map((p) => [p.userId, p.username ?? null])), [people])
  // Destinations come from the whole tree, so a search never hides where a project can go.
  const destinations = useMemo(() => moveDestinations(accessFolders(tree)), [tree])
  const mover = useProjectMove({ orgId, enabled: canMoveProjects, onChanged })
  const editing: FolderEditing = { orgId, grantable, usernames, viewerUsername, onChanged, onRemove: setRemoving }
  // ?place=type:id (ManageAccessLink and older links) marks that row and scrolls to it.
  const marked = params.get("place")

  useEffect(() => {
    const scope = parsePlaceParam(marked)
    if (!scope) return
    document.getElementById(accessNodeId(scope))?.scrollIntoView?.({ block: "center" })
  }, [marked])

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (folders.length === 0) {
    return <p className="px-2 text-sm text-muted-foreground">{t("org.access.places.noMatches")}</p>
  }

  /** What the viewer may create inside this row, with what each choice does. */
  const creatable = (scope: ScopeRef): { kind: ChildKind; label: string; run: () => void }[] => {
    const projectRole = (() => {
      const row = rows.get(placeParam(scope))
      return scope.type === "project" && row?.grantable.ok ? row.grantable.cap : 0
    })()
    return newChildKinds(scope.type).flatMap((kind): { kind: ChildKind; label: string; run: () => void }[] => {
      if (kind === "team" && onNewFolder) {
        return [{ kind, label: t("org.access.tree.newFolder"), run: () => setNamingFolderIn(placeParam(scope)) }]
      }
      if (kind === "project" && onNewProject) {
        const folderId = scope.type === "team" ? Number(scope.id) : null
        return [{ kind, label: t("org.access.tree.newProject"), run: () => onNewProject(Number.isFinite(folderId) ? folderId : null) }]
      }
      if (kind === "lane" && projectRole >= ADD_LANGUAGE_MIN_ROLE) {
        return [{ kind, label: t("org.access.tree.newLanguage", { name: scope.name }), run: () => onNewLanguage(scope.id) }]
      }
      return []
    })
  }

  const renderFolder = (folder: FolderNode, depth: number) => {
    const { scope } = folder.node
    const key = placeParam(scope)
    const isCollapsed = collapsed.has(key) && !query
    const row = rows.get(key)
    const canGrant = row != null && row.grantable.ok
    const Icon = PLACE_ICON[scope.type]
    const choices = creatable(scope)
    const naming = namingFolderIn === key && onNewFolder != null
    const hasChildren = folder.children.length > 0 || naming
    const destination: MoveDestination | null =
      scope.type === "org" ? { id: null, scope } : scope.type === "team" ? { id: scope.id, scope } : null
    const drop = mover.dropTargetProps(destination)
    return (
      <li key={key} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined} aria-selected={marked === key}>
        <div
          id={accessNodeId(scope)}
          data-testid={accessNodeId(scope)}
          data-drop-target={drop.isTarget || undefined}
          {...mover.dragSource(folder)}
          {...drop.props}
          className={cn(
            "group/folder flex min-h-10 min-w-0 scroll-mt-16 items-center gap-1.5 rounded-md pe-2 hover:bg-accent/40 focus-within:bg-accent/40",
            marked === key && "bg-accent/60",
            scope.type === "project" && mover.enabled && "cursor-grab active:cursor-grabbing",
            drop.isTarget && "bg-primary/10 ring-2 ring-inset ring-primary/60",
            (mover.dragging === key || mover.moving === key) && "opacity-50",
          )}
          style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
        >
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t(isCollapsed ? "org.access.tree.expand" : "org.access.tree.collapse", { name: scope.name })}
              onClick={() => toggle(key)}
              data-testid="folder-toggle"
            >
              <ChevronRight className={cn("transition-transform", !isCollapsed && "rotate-90")} aria-hidden />
            </Button>
          ) : (
            <span className="size-6 shrink-0" aria-hidden />
          )}
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden data-place-icon={scope.type} />
          <span className={cn("min-w-0 truncate text-sm", depth === 0 ? "font-semibold" : scope.type === "lane" ? "" : "font-medium")}>
            {scope.name}
          </span>
          <span className="shrink-0 text-xs lowercase text-muted-foreground">{t(KIND_LABEL[scope.type])}</span>
          <NewChildButton name={scope.name} choices={choices} />
          {scope.type === "project" && mover.enabled && (
            <MoveProjectMenu
              project={folder}
              destinations={destinations}
              disabled={mover.moving != null}
              onMove={(to) => void mover.move(folder, to)}
            />
          )}
          <span className="flex-1" />
          <FolderPeopleStack folder={folder} editing={editing} />
          {canGrant && row ? (
            <AddPersonPopover orgId={orgId} place={row} people={people} onGranted={onChanged} />
          ) : (
            <span className="size-7 shrink-0" aria-hidden />
          )}
        </div>
        {hasChildren && !isCollapsed && (
          <ul role="group" className="flex flex-col">
            {naming && onNewFolder && (
              <NewFolderRow
                depth={depth + 1}
                onCancel={() => setNamingFolderIn(null)}
                onCreate={async (name) => {
                  await onNewFolder(name)
                  setNamingFolderIn(null)
                }}
              />
            )}
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-1" data-testid="access-folder-tree">
      <ul role="tree" aria-label={t("org.access.page.title")} className="flex flex-col">
        {folders.map((folder) => renderFolder(folder, 0))}
      </ul>
      {removing && (
        <RemoveAccessDialog
          open
          onOpenChange={(open) => { if (!open) setRemoving(null) }}
          orgId={orgId}
          person={removing.person}
          grants={removing.grants}
          onRemoved={onChanged}
        />
      )}
    </div>
  )
}

/** The hover "+" on a row: one button when there is one thing to make, a short menu when there are two. */
function NewChildButton({ name, choices }: { name: string; choices: { kind: ChildKind; label: string; run: () => void }[] }) {
  const t = useT()
  if (choices.length === 0) return null
  const className = "opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
  if (choices.length === 1) {
    const only = choices[0]
    return (
      <AppTooltip content={only.label}>
        <Button type="button" variant="outline" size="icon-xs" aria-label={only.label} onClick={only.run} data-testid="folder-new" className={className}>
          <Plus aria-hidden />
        </Button>
      </AppTooltip>
    )
  }
  const label = t("org.access.tree.newIn", { name })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size="icon-xs" className={className} />}
        aria-label={label}
        data-testid="folder-new"
      >
        <Plus aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {choices.map((choice) => {
          const Icon = PLACE_ICON[choice.kind]
          return (
            <DropdownMenuItem key={choice.kind} onClick={choice.run} data-testid={`folder-new-${choice.kind}`}>
              <Icon aria-hidden />
              {choice.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The inline row where a new folder is named. Enter creates it, Escape cancels. */
function NewFolderRow({ depth, onCancel, onCreate }: { depth: number; onCancel: () => void; onCreate: (name: string) => Promise<void> }) {
  const t = useT()
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const Icon = PLACE_ICON.team
  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setFailed(false)
    try {
      await onCreate(trimmed)
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }
  return (
    <li
      data-testid="new-folder-row"
      className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-dashed border-primary/40 bg-accent/30 py-1 pe-2"
      style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
    >
      <span className="size-6 shrink-0" aria-hidden />
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void create()
          if (event.key === "Escape") onCancel()
        }}
        placeholder={t("org.access.tree.folderName")}
        aria-label={t("org.access.tree.folderName")}
        className="h-8 min-w-40 flex-1"
      />
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="button" size="sm" disabled={!name.trim() || saving} onClick={() => void create()} data-testid="new-folder-create">
        {t("org.access.tree.createFolder")}
      </Button>
      {failed && <p role="alert" className="basis-full ps-8 text-sm text-destructive">{t("org.access.tree.folderFailed")}</p>}
    </li>
  )
}
