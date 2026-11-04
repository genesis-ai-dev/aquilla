import type {
  StyleRule,
  StyleRuleCategory,
  StyleRuleScope,
} from "@/lib/rules/style-rule-types"

/** Already-translated style-rule vocabulary, resolved once per render tree. */
export interface StyleRuleLabels {
  /** Category order — broad vocabulary first, catch-all last. */
  categoryOrder: readonly StyleRuleCategory[]
  category: Record<StyleRuleCategory, string>
  scope: Record<StyleRuleScope, string>
  severity: Record<StyleRule["severity"], string>
}
