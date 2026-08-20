/**
 * ChangesetHeldNotice.tsx — the "held" line every pending-changeset list ends
 * with (docs/COMMAND-REGISTRY-P1.md §3.3 / §5).
 *
 * The inbox is capped on purpose: the list route ranks staged changesets by
 * blast radius and surfaces `SURFACED_CAP` of them, reporting the rest as
 * `heldCount` — a NUMBER, never more rows. A queue that grows without bound is
 * a queue nobody reads, and the cap is what keeps the surfaced few reviewable.
 *
 * Held rows stay `staged` — held, not closed — so nothing is lost: they
 * surface as the ones above them are dealt with, and a later supersession
 * sweep can still close them. The second line says exactly that, because
 * "2 more held" alone reads like something was discarded.
 *
 * There is no pending-changeset list surface in the SPA yet (the only
 * changeset surfaces today are the in-conversation card and /approve/:id), so
 * this renders the contract's line and nothing else — the list that mounts it
 * owns the rows.
 */

import { Layers } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

export function ChangesetHeldNotice({ heldCount }: { heldCount: number }) {
  const t = useT()
  // Nothing held is not a state worth a line — the list is simply complete.
  if (heldCount <= 0) return null
  return (
    <div
      data-held-count={heldCount}
      className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
    >
      <Layers className="mt-px h-3 w-3 shrink-0" />
      <span>
        <span className="font-medium text-foreground">
          {t("agent.changeset.heldCount", { count: heldCount })}
        </span>{" "}
        {t("agent.changeset.heldNotice")}
      </span>
    </div>
  )
}
