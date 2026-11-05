/**
 * AQU-2342: the scope chip(s) a row of the unified Checks list leads with —
 * Org / Project / a language lane / Book … / Genre … / File … / Built-in.
 */
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ApplicabilityTargetType, StyleRuleScope } from "@/lib/rules/style-rule-types"
import type { CheckScopeChip } from "./check-rows"

const TARGET_KEY: Record<ApplicabilityTargetType, MessageKey> = {
  book: "rules.checks.scope.book",
  genre: "rules.checks.scope.genre",
  file: "rules.checks.scope.file",
  section: "rules.checks.scope.section",
  passage: "rules.checks.scope.passage",
  segment: "rules.checks.scope.segment",
}

const STYLE_SCOPE_KEY: Record<StyleRuleScope, MessageKey> = {
  global: "terminology.livingMemory.styleRules.scope.global",
  genre: "terminology.livingMemory.styleRules.scope.genre",
  document: "terminology.livingMemory.styleRules.scope.document",
  section: "terminology.livingMemory.styleRules.scope.section",
  passage: "terminology.livingMemory.styleRules.scope.passage",
  segment: "terminology.livingMemory.styleRules.scope.segment",
}

/** More targets than this collapse into "+N". */
const MAX_TARGET_CHIPS = 3

interface ScopeChipsProps {
  chips: readonly CheckScopeChip[]
  /** A lane tag's display name. */
  laneName: (tag: string) => string
  /** A file id's display name (style rules can target a file). */
  fileName?: (fileId: string) => string
}

export function ScopeChips({ chips, laneName, fileName }: ScopeChipsProps) {
  const t = useT()
  const shown = chips.slice(0, MAX_TARGET_CHIPS)
  const hidden = chips.length - shown.length
  return (
    <>
      {shown.map((chip, index) => {
        const key = `${chip.kind}-${index}`
        switch (chip.kind) {
          case "org":
            return <Badge key={key} data-scope="org">{t("common.org")}</Badge>
          case "project":
            return <Badge key={key} variant="secondary" data-scope="project">{t("rules.checks.scope.project")}</Badge>
          case "builtin":
            return <Badge key={key} variant="outline" data-scope="builtin">{t("rules.checks.scope.builtin")}</Badge>
          case "bible":
            return <Badge key={key} variant="outline" data-scope="bible">{t("bibleData.enrichment.checks.label")}</Badge>
          case "lane":
            if (chip.relation === "all") {
              return <Badge key={key} variant="secondary" data-scope="lane">{t("rules.surface.laneScope.badgeAll")}</Badge>
            }
            if (chip.relation === "this") {
              return <Badge key={key} data-scope="lane">{t("rules.surface.laneScope.badgeThis", { lane: laneName(chip.lane) })}</Badge>
            }
            return (
              <Badge key={key} variant="outline" className="border-dashed" data-scope="lane">
                {t("rules.surface.laneScope.badgeOther", { lane: laneName(chip.lane) })}
              </Badge>
            )
          case "target": {
            const name = chip.targetType === "file" ? (fileName?.(chip.targetId) ?? chip.targetId) : chip.targetId
            return (
              <Badge key={key} variant="secondary" data-scope={chip.targetType}>
                {t(TARGET_KEY[chip.targetType], { name })}
              </Badge>
            )
          }
          case "styleScope":
            return <Badge key={key} variant="secondary" data-scope={chip.scope}>{t(STYLE_SCOPE_KEY[chip.scope])}</Badge>
        }
      })}
      {hidden > 0 && <Badge variant="outline">{t("rules.checks.scope.more", { count: hidden })}</Badge>}
    </>
  )
}
