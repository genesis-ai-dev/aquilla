import type {
  TranslationRule,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

const FROZEN_CREATED_AT = "1970-01-01T00:00:00.000Z"

export function resolveBuiltinRules(
  overrides: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>> | undefined,
): TranslationRule[] {
  return BUILTIN_CHECK_IDS.map((id) => {
    const def = BUILTIN_CHECKS[id]
    const ov = overrides?.[id]
    return {
      id: `builtin:${id}`,
      name: def.name,
      description: def.description,
      severity: ov?.severity ?? def.defaultSeverity,
      source: "algorithmic",
      scope: "project",
      enabled: ov?.enabled ?? def.defaultEnabled,
      createdAt: FROZEN_CREATED_AT,
      check: { type: "builtin", checkId: id },
    }
  })
}
