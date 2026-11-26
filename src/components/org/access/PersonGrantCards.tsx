/**
 * AQU-2323: one card per direct grant — role (a dropdown where this viewer
 * may change it), where it sits, who gave it and when, what depends on it,
 * and Remove — then the person's history. A grant that changes no place the
 * viewer can see says so in amber: removing it is safe.
 */
import { AlertTriangle, History, Trash2 } from "lucide-react"

import { roleLabel } from "@/components/access/labels"
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { AppTooltip } from "@/components/ui/tooltip"
import { rowEdit, rowRemoval, type GrantRef } from "@/lib/access/edit-access"
import type { PlaceGrantability } from "@/lib/access/grant-rules"
import { placeCountText, placePath } from "@/lib/access/person-inspector"
import { placeParam } from "@/lib/access/place-lens"
import { formatScopePath } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useFormat } from "@/lib/i18n/format"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

import { editDeniedText } from "./edit-access-text"
import type { PersonAccessPayload, PersonGrantCard, PersonHistoryEntry } from "./person-access-data"
import { RoleDropdown } from "./RoleDropdown"

export interface GrantCardEditing {
  orgId: number
  grantable: Readonly<Record<string, PlaceGrantability>> | undefined
  isSelf: boolean
  onChanged: () => void
  onRemove: (grants: GrantRef[]) => void
}

export function PersonGrantCards({ data, editing }: { data: PersonAccessPayload; editing: GrantCardEditing }) {
  const t = useT()
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="person-grants-heading">
      <h2 id="person-grants-heading" className="text-sm font-medium">{t("org.access.person.grantsHeading")}</h2>
      {data.grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("org.access.person.noGrants")}</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {data.grants.map((card) => (
            <li key={`${card.source}:${placeParam(card.grant)}`}>
              <GrantCard card={card} person={data.person} editing={editing} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function GrantCard({ card, person, editing }: { card: PersonGrantCard; person: PersonAccessPayload["person"]; editing: GrantCardEditing }) {
  const t = useT()
  const fmt = useFormat()
  const place: ScopeRef = card.path[card.path.length - 1] ?? { type: card.grant.type, id: card.grant.id, name: "" }
  const row = { userId: person.userId, roleLevel: card.roleLevel, source: card.source }
  const edit = rowEdit(place, row, editing.grantable, editing.isSelf)
  const removal = rowRemoval(place, card.path, row, editing.grantable, editing.isSelf)
  const date = card.grantedAt ? fmt.date(new Date(card.grantedAt), { dateStyle: "medium" }) : null
  const given = card.grantedBy && date
    ? t("org.access.person.grantedBy", { name: card.grantedBy, date })
    : date ? t("org.access.person.grantedOn", { date }) : t("org.access.person.grantedUnknown")
  const gives = placeCountText(t, card.gives)
  const remove = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={!removal.ok}
      aria-label={t("org.access.person.removeGrant", { role: roleLabel(t, card.roleLevel), path: formatScopePath(placePath(card.path)) })}
      onClick={() => editing.onRemove([card.grant])}
      data-testid="grant-card-remove"
    >
      <Trash2 aria-hidden />
    </Button>
  )
  return (
    <Card size="sm" data-testid="grant-card" data-grant={placeParam(card.grant)} className="min-w-0">
      <CardContent className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <ScopeBreadcrumb path={placePath(card.path)} />
          <span className="flex shrink-0 items-center gap-1">
            <RoleDropdown
              orgId={editing.orgId}
              place={place}
              path={card.path}
              person={{ userId: person.userId, displayName: person.displayName, username: person.username }}
              roleLevel={card.roleLevel}
              origin={card.source === "creator" ? { kind: "creator" } : { kind: "direct" }}
              edit={edit}
              onChanged={editing.onChanged}
            />
            {card.source === "direct" && (removal.ok ? remove : <AppTooltip content={editDeniedText(t, removal.reason, removal.cap)}>{remove}</AppTooltip>)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="grant-card-given">{given}</p>
        {gives && <p className="text-xs text-muted-foreground">{t("org.access.person.gives", { list: gives })}</p>}
        {card.source === "creator" && <p className="text-xs text-muted-foreground">{t("org.access.person.creatorCard")}</p>}
        {card.redundant && (
          <p
            data-testid="grant-card-redundant"
            className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs text-amber-800 dark:text-amber-200"
          >
            <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            {t("org.access.person.redundant")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function historyText(t: TFunction, entry: PersonHistoryEntry): string {
  const path = formatScopePath(placePath(entry.path))
  const role = roleLabel(t, entry.kind === "removed" ? entry.roleBefore : entry.roleAfter)
  if (entry.kind === "changed") {
    const vars = { path, before: roleLabel(t, entry.roleBefore), after: roleLabel(t, entry.roleAfter) }
    return entry.by ? t("org.access.person.history.changed", { ...vars, by: entry.by }) : t("org.access.person.history.changedNoActor", vars)
  }
  if (entry.kind === "removed") {
    return entry.by ? t("org.access.person.history.removed", { by: entry.by, role, path }) : t("org.access.person.history.removedNoActor", { role, path })
  }
  return entry.by ? t("org.access.person.history.granted", { by: entry.by, role, path }) : t("org.access.person.history.grantedNoActor", { role, path })
}

export function PersonHistory({ history }: { history: PersonHistoryEntry[] }) {
  const t = useT()
  const fmt = useFormat()
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="person-history-heading">
      <h2 id="person-history-heading" className="flex items-center gap-1.5 text-sm font-medium">
        <History className="size-4 text-muted-foreground" aria-hidden />
        {t("org.access.person.historyHeading")}
      </h2>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("org.access.person.historyEmpty")}</p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-1.5" data-testid="person-history">
          {history.map((entry, i) => (
            <li key={`${entry.at}:${i}`} data-testid="person-history-entry" className="flex min-w-0 flex-col text-sm sm:flex-row sm:gap-3">
              <time dateTime={entry.at} className="shrink-0 text-muted-foreground tabular-nums">
                {fmt.date(new Date(entry.at), { dateStyle: "medium" })}
              </time>
              <span className="min-w-0 break-words">{historyText(t, entry)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">{t("org.access.person.historyNote")}</p>
    </section>
  )
}
