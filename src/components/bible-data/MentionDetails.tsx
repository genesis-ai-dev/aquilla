// Who's Who (AQU-1689): the popover behind a mention word in the source text.
//
// Who the word refers to (a group by its members, never as one of them), how
// it refers to them (Named / Pronoun / Implied subject), gender and number,
// where the current passage first mentions them, how sure the data is and
// which datasets say so, previous/next mention jumps, the cell filter, and
// where the name came from. Opened on hover and on keyboard focus.
//
// AQU-1695: the title is the mention's own name (a deity's form at that word,
// when the pack gives one), and pack 1.1's description and family follow the
// facts (EntityAbout).

import { ArrowDown, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PopoverTitle } from "@/components/ui/popover"
import { entityGender, entityNumber } from "@/lib/bible-data/entity-facts"
import {
  adjacentMentionRef,
  entityOf,
  pericopeAt,
  pericopeCast,
  type MentionAt,
  type MentionDirection,
} from "@/lib/bible-data/people-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { EntityAbout } from "./EntityAbout"
import { GENDER_KEYS, NUMBER_KEYS, mentionKindKey, mentionSourceKeys } from "./people-text"
import { labelSourceKey } from "./voice-text"
import type { CellMentionView } from "./whos-who-context"

/** Hops at or beyond which the chain is worth saying out loud (the brief: "when hops > 1"). */
const SHOW_HOPS_FROM = 2

interface MentionDetailsProps {
  id: string
  view: CellMentionView
  at: MentionAt
  /**
   * How the word was found in the cell (AQU-1694): it is the pack's own word
   * ("exact"), or the stored word alignment put it there ("aligned"), with
   * low confidence ("approximate").
   */
  placement?: "exact" | "aligned" | "approximate"
  /** After a jump: the row this popover hangs from may scroll away. */
  onJumped: () => void
}

export function MentionDetails({ id, view, at, placement = "exact", onJumped }: MentionDetailsProps) {
  const t = useT()
  const fmt = useFormat()
  const { context, refs } = view
  const { entity, kind, hops, conf, src } = at.mention
  const info = entityOf(context.index, entity)
  const name = context.nameOf(entity)
  const isGroup = (info?.members?.length ?? 0) > 0
  const label = isGroup ? null : context.labelFor(entity)

  const pericope = pericopeAt(context.index, at.ref)
  const first = pericope ? pericopeCast(context.index, pericope).find((member) => member.entity === entity)?.first : undefined

  const kindKey = mentionKindKey(kind)
  const gender = entityGender(info)
  const number = entityNumber(info)
  const facts = [
    kindKey ? t(kindKey) : null,
    gender ? t(GENDER_KEYS[gender]) : null,
    number ? t(NUMBER_KEYS[number]) : null,
  ].filter((fact): fact is string => fact !== null)

  const sources = mentionSourceKeys(src).map((key) => t(key))

  const jump = (direction: MentionDirection) => {
    const target = adjacentMentionRef(context.index, entity, refs, direction)
    if (!target) return
    context.jumpTo(target, entity)
    onJumped()
  }
  const previous = adjacentMentionRef(context.index, entity, refs, "previous")
  const next = adjacentMentionRef(context.index, entity, refs, "next")

  return (
    <div id={id} data-testid="mention-details" className="flex flex-col gap-2 text-xs">
      <PopoverTitle className="text-sm" dir="auto">
        {isGroup ? (
          t("bibleData.whosWho.groupMembers", { members: fmt.isolate(name) })
        ) : (
          <bdi>{context.mentionName(at)}</bdi>
        )}
      </PopoverTitle>
      {facts.length > 0 && <p className="text-muted-foreground">{facts.join(" · ")}</p>}
      <EntityAbout
        index={context.index}
        entity={entity}
        nameOf={context.nameOf}
        jump={(ref, relative) => {
          context.jumpTo(ref, relative)
          onJumped()
        }}
      />
      {first && <p>{t("bibleData.whosWho.firstMention", { ref: fmt.isolate(first.ref) })}</p>}
      {placement !== "exact" && (
        <p data-testid="mention-placement" className="text-muted-foreground">
          {t(placement === "approximate" ? "bibleAlignment.placedApproximate" : "bibleAlignment.placedAligned")}
        </p>
      )}
      {(sources.length > 0 || hops >= SHOW_HOPS_FROM) && (
        <p className="text-muted-foreground">
          {sources.length > 0 &&
            t("bibleData.whosWho.evidence", {
              confidence: fmt.isolate(fmt.percent(conf)),
              sources: fmt.list(sources, { type: "conjunction" }),
            })}
          {hops >= SHOW_HOPS_FROM && (
            <span data-testid="mention-hops" className="block">
              {t("bibleData.whosWho.hops", { count: hops })}
            </span>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {previous ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 py-0.5 text-xs"
            aria-label={t("bibleData.whosWho.previousMentionAria", { name: fmt.isolate(name) })}
            onClick={() => jump("previous")}
          >
            <ArrowUp className="size-3" aria-hidden="true" />
            {t("bibleData.whosWho.previousMention")}
          </Button>
        ) : (
          <span className="text-muted-foreground">{t("bibleData.whosWho.noEarlierMention")}</span>
        )}
        {next ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 py-0.5 text-xs"
            aria-label={t("bibleData.whosWho.nextMentionAria", { name: fmt.isolate(name) })}
            onClick={() => jump("next")}
          >
            <ArrowDown className="size-3" aria-hidden="true" />
            {t("bibleData.whosWho.nextMention")}
          </Button>
        ) : (
          <span className="text-muted-foreground">{t("bibleData.whosWho.noLaterMention")}</span>
        )}
      </div>
      {context.showMentionsOf && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start px-0 py-0.5 text-xs"
          onClick={() => {
            context.showMentionsOf?.(entity)
            onJumped()
          }}
        >
          {t("bibleData.whosWho.showMentions", { name: fmt.isolate(name) })}
        </Button>
      )}
      {label && <p className="border-t border-border/60 pt-2 text-muted-foreground">{t(labelSourceKey(label))}</p>}
    </div>
  )
}
