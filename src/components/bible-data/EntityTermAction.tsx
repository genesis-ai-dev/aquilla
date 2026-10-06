// "Add to terminology", or "Link “Jesus” to Jesus", for one participant in a
// Voices or Who's Who popover (AQU-1693). When it shows, and what a click
// does, is decided in src/lib/bible-data/entity-terms.ts.

import { useContext } from "react"
import { Button } from "@/components/ui/button"
import { entityTermAction } from "@/lib/bible-data/entity-terms"
import type { BkpEntity } from "@/lib/bible-data/pack-types"
import { useFormat } from "@/lib/i18n/format"
import { useT } from "@/lib/i18n/I18nProvider"
import { EntityTermActionsContext } from "./entity-term-context"

interface EntityTermActionProps {
  entity: BkpEntity | undefined
  /** The name the popover shows for the participant. */
  name: string
  /** The lemma of the word that names the participant (a mention that names them). */
  lemma?: string
  /** After a click: the popover hanging from a row may close. */
  onDone?: () => void
}

export function EntityTermAction({ entity, name, lemma, onDone }: EntityTermActionProps) {
  const t = useT()
  const fmt = useFormat()
  const actions = useContext(EntityTermActionsContext)
  if (!actions) return null
  const action = entityTermAction(entity, {
    concepts: actions.concepts,
    termMatching: actions.termMatching,
    sourceLanguage: actions.sourceLanguage,
    canAdd: actions.add !== null,
    canLink: actions.link !== null,
    ...(lemma ? { lemma } : {}),
  })
  if (!action) return null

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto self-start px-0 py-0.5 text-xs"
      aria-label={action.kind === "add" ? t("bibleData.terms.addAria", { name: fmt.isolate(name) }) : undefined}
      onClick={() => {
        if (action.kind === "add") actions.add?.(action.draft)
        else
          actions.link?.({
            conceptId: action.concept.id,
            externalIds: action.externalIds,
            term: action.concept.sourceTerm,
            name,
          })
        onDone?.()
      }}
    >
      {action.kind === "add"
        ? // The same action as "Add to terminology" on a source selection.
          t("workspace.sourceSelection.addToTermbase")
        : t("bibleData.terms.linkEntry", { term: fmt.isolate(action.concept.sourceTerm), name: fmt.isolate(name) })}
    </Button>
  )
}
