// src/lib/codex-editor/merge/strategies.ts
// Ported from codex-editor/src/projectManager/utils/merge/strategies.ts,
// minus the SPECIAL strategy (unused) and ARRAY (we collapse into COMMENTS).

export const Strategy = {
  CODEX: "codex",
  COMMENTS: "comments",
  METADATA: "metadata",
  JSON_MERGE: "json-merge",
  IGNORE: "ignore",
  OVERRIDE: "override",
} as const

export type Strategy = (typeof Strategy)[keyof typeof Strategy]

export const filePatternsToResolve: Record<Strategy, string[]> = {
  [Strategy.CODEX]: ["files/target/*.codex", ".project/sourceTexts/*.source"],
  [Strategy.COMMENTS]: [".project/comments.json"],
  [Strategy.METADATA]: ["metadata.json"],
  [Strategy.JSON_MERGE]: [".vscode/settings.json"],
  [Strategy.IGNORE]: ["complete_drafts.txt"],
  [Strategy.OVERRIDE]: [],
}

export function determineStrategy(filePath: string): Strategy {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "")

  for (const [strategy, patterns] of Object.entries(filePatternsToResolve) as
      Array<[Strategy, string[]]>) {
    for (const pattern of patterns) {
      if (strategy === Strategy.IGNORE) {
        if (normalized === pattern || normalized.endsWith("/" + pattern)) return strategy
        continue
      }
      if (pattern.includes("*")) {
        const regex = new RegExp(pattern.replace(/\./g, "\\.").replace("*", ".*"))
        if (regex.test(normalized)) return strategy
      } else if (normalized === pattern || normalized.endsWith("/" + pattern)) {
        return strategy
      }
    }
  }

  return normalized.endsWith(".json") ? Strategy.JSON_MERGE : Strategy.OVERRIDE
}
