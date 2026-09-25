/**
 * TermFormsSection (AQU-1271) — the "which source forms does this term hit"
 * block on the term detail page: the discovered surface forms as toggleable
 * chips, a manual add-a-form escape hatch, and the shared matching options.
 *
 * Lives outside TerminologyTermDetail.tsx only because that file is already at
 * its size budget; it is otherwise a plain sub-section of that page.
 *
 * Every edit hands the caller the WHOLE pruned match object rather than a
 * delta: `term.update` replaces `match_options` wholesale, exactly as it does
 * renderings, so a partial write would silently drop the options it omitted.
 */

import { useMemo } from "react"
import { Input } from "@/components/ui/input"
import { DiscoveredFormsChips } from "@/components/terminology/DiscoveredFormsChips"
import { MatchOptionsFields } from "@/components/terminology/MatchOptionsFields"
import { discoverForms } from "@/lib/terminology/discover-forms"
import { hasCombiningMarks, pruneMatch, resolveMatchOptions } from "@/lib/terminology/match-options"
import type { Concept, TermMatchingSettings, TermMatchOptions } from "@/lib/terminology/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  concept: Concept
  /** Cells to derive the surface forms from — the same list the page filters. */
  cells: ReadonlyArray<{ id: string; original: string }>
  termMatching?: TermMatchingSettings
  /** False renders the section read-only (chips still show what matched). */
  canEdit: boolean
  onMatchChange?: (conceptId: string, match: TermMatchOptions | undefined) => void | Promise<void>
  onCaseSensitiveChange?: (conceptId: string, caseSensitive: boolean) => void | Promise<void>
  onSetUpAffixes?: () => void
}

export function TermFormsSection({
  concept,
  cells,
  termMatching,
  canEdit,
  onMatchChange,
  onCaseSensitiveChange,
  onSetUpAffixes,
}: Props) {
  const t = useT()
  const discovered = useMemo(
    () => discoverForms(cells, concept, termMatching),
    [cells, concept, termMatching],
  )
  const resolved = useMemo(
    () => resolveMatchOptions(concept, termMatching),
    [concept, termMatching],
  )

  const emit = (next: TermMatchOptions) => void onMatchChange?.(concept.id, pruneMatch(next))

  return (
    <section className="grid gap-2" data-testid="term-forms">
      <h3 className="text-xs font-medium">{t("terminology.match.formsLabel")}</h3>
      <DiscoveredFormsChips
        forms={discovered}
        disabled={!canEdit}
        onToggleExclude={(surface, excluded) => {
          const current = concept.match?.excludedForms ?? []
          emit({
            ...concept.match,
            excludedForms: excluded
              ? [...new Set([...current, surface])]
              : current.filter((f) => f !== surface),
          })
        }}
      />
      {canEdit && (
        <Input
          placeholder={t("terminology.match.addFormPlaceholder")}
          aria-label={t("terminology.match.addFormLabel")}
          className="h-7 text-xs"
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            // AQU-1272: an IME composes with Enter. Committing the form on that
            // keystroke would add the half-composed reading and swallow the
            // confirmation — exactly the languages this field exists for.
            if (e.nativeEvent.isComposing) return
            e.preventDefault()
            const value = e.currentTarget.value.trim()
            if (!value) return
            emit({
              ...concept.match,
              forms: [...new Set([...(concept.match?.forms ?? []), value])],
            })
            e.currentTarget.value = ""
          }}
        />
      )}
      <MatchOptionsFields
        idPrefix={`term-${concept.id}`}
        value={concept.match ?? {}}
        resolved={resolved}
        showFoldMarks={
          hasCombiningMarks(concept.sourceTerm) || discovered.some((f) => hasCombiningMarks(f.surface))
        }
        hasAffixInventory={resolved.prefixes.length + resolved.suffixes.length > 0}
        caseSensitive={concept.caseSensitive === true}
        disabled={!canEdit}
        onChange={emit}
        onCaseSensitiveChange={(v) => void onCaseSensitiveChange?.(concept.id, v)}
        onSetUpAffixes={onSetUpAffixes}
      />
    </section>
  )
}
