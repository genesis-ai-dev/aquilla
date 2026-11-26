/**
 * AQU-2323: "Where X can go" — the viewer's tree cut down to the places this
 * person reaches, each with their role (solid where granted there, dashed
 * from the place it comes from) and the reason in words. Every place they
 * cannot reach collapses into one No access row at the bottom; choosing one
 * of those places opens Give access for it.
 */
import { useState } from "react"
import { ChevronDown, ChevronRight, Lock, UserPlus } from "lucide-react"

import { PLACE_ICON } from "@/components/access/place-icons"
import { RoleBadge } from "@/components/access/RoleBadge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { placeParam } from "@/lib/access/place-lens"
import { placeCountText, placeLensHref, placePath, reasonLines, roleOrigin } from "@/lib/access/person-inspector"
import { formatScopePath } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useFormat } from "@/lib/i18n/format"
import { useT } from "@/lib/i18n/I18nProvider"

import type { PersonAccessPayload, PersonPlaceNode } from "./person-access-data"

export function PersonPlacesTree({
  data,
  accessPath,
  onGiveAt,
}: {
  data: PersonAccessPayload
  /** The People & access page, for links to the place a role comes from. */
  accessPath: string
  /** Opens Give access with this person and place filled in. Absent: the viewer may give access nowhere. */
  onGiveAt?: (place: ScopeRef) => void
}) {
  const t = useT()
  const name = data.person.displayName
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="person-where-heading">
      <h2 id="person-where-heading" className="text-sm font-medium">{t("org.access.person.whereHeading", { name })}</h2>
      {data.tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("org.access.person.nowhere", { name })}</p>
      ) : (
        <ul className="flex min-w-0 flex-col" data-testid="person-tree">
          {data.tree.map((node) => (
            <PlaceRow key={placeParam(node.scope)} node={node} depth={0} accessPath={accessPath} />
          ))}
        </ul>
      )}
      {data.noAccess.places.length > 0 && <NoAccessBucket data={data} onGiveAt={onGiveAt} />}
    </section>
  )
}

function PlaceRow({ node, depth, accessPath }: { node: PersonPlaceNode; depth: number; accessPath: string }) {
  const t = useT()
  const fmt = useFormat()
  const Icon = PLACE_ICON[node.scope.type]
  const lines = reasonLines(t, node.role, (names) => fmt.list(names, { type: "conjunction" }))
  return (
    <li className="min-w-0">
      <div
        data-testid="person-place"
        data-place={placeParam(node.scope)}
        className="flex min-w-0 flex-col gap-1 border-b py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
        style={{ paddingInlineStart: `${Math.min(depth, 4) * 1}rem` }}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon={node.scope.type} />
            <span className="truncate">{node.scope.name}</span>
          </span>
          {lines.map((line, i) => (
            <span
              key={i}
              data-testid={i === 0 ? "person-place-reason" : "person-place-also"}
              className={i > 0 && node.role.redundantDirect ? "text-xs text-amber-700 dark:text-amber-300" : "text-xs text-muted-foreground"}
            >
              {line}
            </span>
          ))}
        </div>
        <RoleBadge
          roleLevel={node.role.roleLevel}
          origin={roleOrigin(node.role)}
          hrefFor={(ref) => placeLensHref(accessPath, ref)}
          className="self-start"
        />
      </div>
      {node.children.length > 0 && (
        <ul className="flex min-w-0 flex-col">
          {node.children.map((child) => (
            <PlaceRow key={placeParam(child.scope)} node={child} depth={depth + 1} accessPath={accessPath} />
          ))}
        </ul>
      )}
    </li>
  )
}

function NoAccessBucket({ data, onGiveAt }: { data: PersonAccessPayload; onGiveAt?: (place: ScopeRef) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-dashed">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          data-testid="no-access-toggle"
          className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{t("org.access.person.noAccessTitle")}</span>
            <span data-testid="no-access-counts" className="text-muted-foreground">{placeCountText(t, data.noAccess.counts)}</span>
            {onGiveAt && <span className="text-xs text-muted-foreground">{t("org.access.person.noAccessHint")}</span>}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex min-w-0 flex-col border-t" data-testid="no-access-list">
          {data.noAccess.places.map(({ scope, path }) => {
            const Icon = PLACE_ICON[scope.type]
            const label = t("org.access.person.giveHereAriaLabel", { name: data.person.displayName, path: formatScopePath(placePath(path)) })
            const body = (
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon={scope.type} />
                <span className="truncate">{formatScopePath(placePath(path))}</span>
              </span>
            )
            return (
              <li key={placeParam(scope)} data-testid="no-access-place" data-place={placeParam(scope)} className="group flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50">
                {onGiveAt ? (
                  <>
                    <button type="button" aria-label={label} onClick={() => onGiveAt(scope)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
                      {body}
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      tabIndex={-1}
                      onClick={() => onGiveAt(scope)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100"
                      data-testid="give-here"
                    >
                      <UserPlus aria-hidden />
                      <span className="max-sm:sr-only">{t("org.access.person.giveHere")}</span>
                    </Button>
                  </>
                ) : (
                  <span className="min-w-0 flex-1">{body}</span>
                )}
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
