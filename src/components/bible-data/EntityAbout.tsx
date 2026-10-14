// Who's Who (AQU-1695): what pack 1.1 says about one participant, in the
// mention popover and in the panel's cast.
//
//   • ACAI's short description, in the label language, else English. A
//     place's description is left to the Places enrichment.
//   • Their family ("Father", "Siblings", …). A relative the book mentions is
//     a link to that first mention; one it does not mention is plain text,
//     since there is nowhere to go.

import { Fragment } from "react"
import { Button } from "@/components/ui/button"
import { entityKin, entityRole } from "@/lib/bible-data/entity-facts"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
import { entityOf, type PeopleIndex } from "@/lib/bible-data/people-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { KIN_KEYS } from "./helps-text"
import { useLabelText } from "./useEntityLabels"

interface EntityAboutProps {
  index: PeopleIndex
  entity: BkpEntityId
  nameOf: (entityId: BkpEntityId) => string
  /** Go to a relative's first mention in the book. */
  jump: (ref: BkpRef, entity: BkpEntityId) => void
}

export function EntityAbout({ index, entity, nameOf, jump }: EntityAboutProps) {
  const t = useT()
  const fmt = useFormat()
  const pick = useLabelText()
  const info = entityOf(index, entity)
  const description = entityRole(info) === "place" ? null : pick(info?.descriptions)
  const family = entityKin(info, index.entities)
  if (!description && family.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      {description && (
        <p data-testid="entity-description" lang={description.lang} dir="auto" className="text-muted-foreground">
          {description.text}
        </p>
      )}
      {family.length > 0 && (
        <dl data-testid="entity-kin" className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5">
          {family.map(({ relation, ids }) => (
            <Fragment key={relation}>
              <dt className="text-muted-foreground">{t(KIN_KEYS[relation], { count: ids.length })}</dt>
              <dd>
                <ul className="flex flex-wrap gap-x-2">
                  {ids.map((id) => {
                    const name = nameOf(id)
                    const first = index.refsByEntity.get(id)?.[0]
                    return (
                      <li key={id} data-kin={id} dir="auto">
                        {first ? (
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto px-0 py-0 text-xs"
                            aria-label={t("bibleHelps.kin.goToAria", {
                              name: fmt.isolate(name),
                              ref: fmt.isolate(first),
                            })}
                            onClick={() => jump(first, id)}
                          >
                            <bdi>{name}</bdi>
                          </Button>
                        ) : (
                          <bdi>{name}</bdi>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}
