// Who's Who panel (AQU-1689): the cast of one passage.
//
// One row per participant, most mentioned first: the name (a group by its
// members), how many words refer to them, gender and number, the first
// mention, previous/next mention from where the editor is, and the flags as
// plain sentences that jump to their verse. Choosing a name filters the
// editor to the cells that mention them; choosing it again shows every line.
// Places and anything that is not a person are listed apart, collapsed.

import { ArrowDown, ArrowUp, CircleHelp, UserRoundPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  adjacentMentionRef,
  type CastMember,
  type MentionDirection,
  type PeopleFlag,
  type PeopleIndex,
} from "@/lib/bible-data/people-index"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { GENDER_KEYS, NUMBER_KEYS, flagKey } from "./people-text"

export interface CastActions {
  /** The participant whose cells the editor shows now, if any. */
  filtering: BkpEntityId | null
  toggleFilter: (entity: BkpEntityId) => void
  jump: (ref: BkpRef) => void
}

interface WhosWhoCastProps {
  index: PeopleIndex
  cast: readonly CastMember[]
  /** The verses the editor shows now, for previous/next. */
  hereRefs: readonly BkpRef[]
  nameOf: (entityId: BkpEntityId) => string
  actions: CastActions
}

export function WhosWhoCast({ index, cast, hereRefs, nameOf, actions }: WhosWhoCastProps) {
  const t = useT()
  const participants = cast.filter((member) => member.role === "participant")
  const others = cast.filter((member) => member.role !== "participant")
  return (
    <div className="flex flex-col">
      <ul className="divide-y">
        {participants.map((member) => (
          <CastRow
            key={member.entity}
            index={index}
            member={member}
            hereRefs={hereRefs}
            nameOf={nameOf}
            actions={actions}
          />
        ))}
      </ul>
      {others.length > 0 && (
        <details className="border-t px-3 py-2 text-xs" data-testid="whos-who-others">
          <summary className="cursor-pointer text-muted-foreground">
            {t("bibleData.whosWho.panel.placesAndOthers", { count: others.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {others.map((member) => (
              <li key={member.entity} className="flex justify-between gap-2">
                <FilterName member={member} nameOf={nameOf} actions={actions} className="font-normal" />
                <span className="shrink-0 text-muted-foreground">
                  {t("bibleData.whosWho.panel.mentions", { count: member.count })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function FilterName({
  member,
  nameOf,
  actions,
  className,
}: {
  member: CastMember
  nameOf: (entityId: BkpEntityId) => string
  actions: CastActions
  className?: string
}) {
  const t = useT()
  const fmt = useFormat()
  const name = nameOf(member.entity)
  const isGroup = member.members.length > 0
  return (
    <button
      type="button"
      dir="auto"
      aria-pressed={actions.filtering === member.entity}
      aria-label={t("bibleData.whosWho.showMentions", { name: fmt.isolate(name) })}
      onClick={() => actions.toggleFilter(member.entity)}
      className={cn(
        "min-w-0 rounded-sm text-start font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "aria-pressed:underline aria-pressed:decoration-2",
        className,
      )}
    >
      {isGroup ? t("bibleData.whosWho.groupMembers", { members: fmt.isolate(name) }) : <bdi>{name}</bdi>}
    </button>
  )
}

function CastRow({
  index,
  member,
  hereRefs,
  nameOf,
  actions,
}: {
  index: PeopleIndex
  member: CastMember
  hereRefs: readonly BkpRef[]
  nameOf: (entityId: BkpEntityId) => string
  actions: CastActions
}) {
  const t = useT()
  const fmt = useFormat()
  const name = fmt.isolate(nameOf(member.entity))
  const facts = [
    member.gender ? t(GENDER_KEYS[member.gender]) : null,
    member.number ? t(NUMBER_KEYS[member.number]) : null,
  ].filter((fact): fact is string => fact !== null)
  const adjacent = (direction: MentionDirection) =>
    hereRefs.length > 0 ? adjacentMentionRef(index, member.entity, hereRefs, direction) : null
  const previous = adjacent("previous")
  const next = adjacent("next")

  return (
    <li
      data-testid="whos-who-participant"
      data-entity={member.entity}
      className={cn("flex flex-col gap-1 px-3 py-2 text-xs", actions.filtering === member.entity && "bg-muted/50")}
    >
      <div className="flex items-baseline justify-between gap-2">
        <FilterName member={member} nameOf={nameOf} actions={actions} className="text-sm" />
        <span className="shrink-0 text-muted-foreground">
          {t("bibleData.whosWho.panel.mentions", { count: member.count })}
        </span>
      </div>
      {facts.length > 0 && <p className="text-muted-foreground">{facts.join(" · ")}</p>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 py-0 text-xs"
          aria-label={t("bibleData.whosWho.panel.goToFirstAria", { name, ref: fmt.isolate(member.first.ref) })}
          onClick={() => actions.jump(member.first.ref)}
        >
          {t("bibleData.whosWho.panel.goToFirst", { ref: fmt.isolate(member.first.ref) })}
        </Button>
        {previous && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={t("bibleData.whosWho.previousMentionAria", { name })}
            onClick={() => actions.jump(previous)}
          >
            <ArrowUp className="size-3.5" aria-hidden="true" />
          </Button>
        )}
        {next && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={t("bibleData.whosWho.nextMentionAria", { name })}
            onClick={() => actions.jump(next)}
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
      {member.flags.map((flag) => (
        <FlagLine key={`${flag.code}:${flag.at.wordId}`} flag={flag} nameOf={nameOf} jump={actions.jump} />
      ))}
    </li>
  )
}

function FlagLine({
  flag,
  nameOf,
  jump,
}: {
  flag: PeopleFlag
  nameOf: (entityId: BkpEntityId) => string
  jump: (ref: BkpRef) => void
}) {
  const t = useT()
  const fmt = useFormat()
  const ref = fmt.isolate(flag.at.ref)
  const text =
    flag.code === "possible-ambiguity"
      ? t(flagKey(flag), {
          ref,
          others: fmt.list(flag.others.map((other) => fmt.isolate(nameOf(other))), { type: "disjunction" }),
        })
      : t(flagKey(flag), { ref })
  const Icon = flag.code === "possible-ambiguity" ? CircleHelp : UserRoundPlus
  return (
    <button
      type="button"
      data-testid="whos-who-flag"
      data-flag={flag.code}
      onClick={() => jump(flag.at.ref)}
      className="flex items-start gap-1.5 rounded-sm text-start text-amber-800 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-300"
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span dir="auto">{text}</span>
    </button>
  )
}
