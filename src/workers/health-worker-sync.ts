import type {
  HealthConfig, TranslationRule, RuleInfraction, CellHealthBreakdown, CellHistoryEntry,
} from "@/lib/parsers/types"
import { DualIndex, type CellInput } from "@/lib/search/dual-index"
import { computeCompositeHealth, type CompositeCell } from "@/lib/health/composite/compute"
import { checkRules } from "@/lib/rules/rule-engine"

export interface HealthSyncCell {
  id: string
  fileId: string
  original: string
  translated: string
  validatorCount: number
  history: CellHistoryEntry[]
}

export interface HealthSyncRequest {
  cells: HealthSyncCell[]
  rules: TranslationRule[]
  config: HealthConfig
  requiredValidations: number
}

export interface HealthSyncResponse {
  healthMap: Map<string, number>
  breakdownMap: Map<string, CellHealthBreakdown>
  fileHealth: Map<string, number>
  projectHealth: number
  infractions: Map<string, RuleInfraction[]>
}

export function computeHealthSync(req: HealthSyncRequest): HealthSyncResponse {
  const index = new DualIndex()
  const indexInputs: CellInput[] = req.cells.map((c) => ({
    id: c.id, original: c.original, translated: c.translated, fileId: c.fileId,
  }))
  index.buildFromProject(indexInputs)

  // Rule check. The existing engine expects Map<fileId, CellData[]>; we adapt
  // with a minimal shim since checkRules only reads a handful of fields.
  const fileCells = new Map<string, ReturnType<typeof adaptToRuleEngineCell>[]>()
  for (const c of req.cells) {
    let bucket = fileCells.get(c.fileId)
    if (!bucket) { bucket = []; fileCells.set(c.fileId, bucket) }
    bucket.push(adaptToRuleEngineCell(c))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const infractionsRaw = checkRules(fileCells as any, req.rules)

  const composite: CompositeCell[] = req.cells.map((c) => {
    const last = c.history[c.history.length - 1]
    const examples = last?.examples
    return {
      id: c.id,
      fileId: c.fileId,
      translated: c.translated,
      validatorCount: c.validatorCount,
      examples,
      infractions: infractionsRaw.get(c.id) ?? [],
      branchingSource: index.searchBranchingSource(c.original, req.config.neighborhoodSearchLimit),
      branchingTarget: index.searchBranchingTarget(c.translated, req.config.neighborhoodSearchLimit),
      plainSource: index.searchPlainSource(c.original, req.config.neighborhoodSearchLimit),
      plainTarget: index.searchPlainTarget(c.translated, req.config.neighborhoodSearchLimit),
    }
  })

  const r = computeCompositeHealth({
    cells: composite, rules: req.rules, config: req.config, requiredValidations: req.requiredValidations,
  })

  return {
    healthMap: r.healthMap,
    breakdownMap: r.breakdownMap,
    fileHealth: r.fileHealth,
    projectHealth: r.projectHealth,
    infractions: infractionsRaw,
  }
}

function adaptToRuleEngineCell(c: HealthSyncCell) {
  // checkRules only reads a few fields off CellData. We provide the minimum.
  return {
    id: c.id,
    original: c.original,
    originalHtml: "",
    translated: c.translated,
    context: "",
    group: "",
    type: "text" as const,
    status: (c.translated.trim() ? "unvalidated" : "empty") as "unvalidated" | "empty",
    validationStatus: "none" as const,
    activeValidators: [] as string[],
    history: c.history,
    threads: [],
  }
}
