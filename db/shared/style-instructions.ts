// AQU-2342 phase 2: the style rules in force for the text a worker is about to
// draft — the Checks hint's style lines — resolved exactly as the editor
// resolves them (ProjectWorkspace styleInstructionsFor → src/lib/rules/
// applicability.ts): approved, enabled rules (the project's and its org's)
// whose applicability rows match the cell's place (book, genre, file, range).
//
// Extracted from the Agent API's prompt preview so the agent draft tool,
// DraftCells and Autopilot hint the same style rules the copilot does. A span
// of several cells gets the UNION of what applies to each, de-duplicated, the
// way the copilot's batch prompt unions its chunk.
//
// Best-effort: a failed read is "no style rules", never a failed draft.

import type { AquillaDb } from "../shim/postgres"
import { listRulesForProject } from "./style-rules"
import {
  buildApplicabilityIndex,
  cellCoordinates,
  resolveEffectiveRules,
} from "../../src/lib/rules/applicability"
import type {
  RuleApplicability as ClientRuleApplicability,
  StyleRule as ClientStyleRule,
} from "../../src/lib/rules/style-rule-types"
import { bookGenre } from "../../src/lib/scripture/book-genres"

export interface StyleCell {
  cellId: string
  canonicalRef?: string | null
}

/** The file's genre as the editor resolves it: an explicit `fileGenres`
 *  assignment wins over the one derived from the book code. */
function assignedGenre(settings: Record<string, unknown>, fileId: string): string | undefined {
  const genres = settings.fileGenres
  if (!genres || typeof genres !== "object" || Array.isArray(genres)) return undefined
  const assigned = (genres as Record<string, unknown>)[fileId]
  return typeof assigned === "string" && assigned.trim() ? assigned.trim().toLowerCase() : undefined
}

/**
 * Style-rule instructions in force for `cells` of one file, in resolution
 * order, de-duplicated. [] when the project has no style rules or the read
 * fails.
 */
export async function styleInstructionsForCells(
  db: AquillaDb,
  args: {
    projectId: string
    fileId: string
    cells: readonly StyleCell[]
    settings: Record<string, unknown>
  },
): Promise<string[]> {
  try {
    const { rules, applicability } = await listRulesForProject(db, args.projectId)
    if (rules.length === 0 || args.cells.length === 0) return []
    const file = await db
      .prepare("SELECT book_code FROM files WHERE id = ? AND project_id = ?")
      .bind(args.fileId, args.projectId)
      .first<{ book_code: string | null }>()
    const genre = assignedGenre(args.settings, args.fileId)
    // The worker's rows carry a looser checkSpec type than the client's; the
    // resolver never reads it.
    const index = buildApplicabilityIndex(applicability as unknown as ClientRuleApplicability[])
    const out: string[] = []
    const seen = new Set<string>()
    for (const cell of args.cells) {
      const coords = cellCoordinates(
        { id: cell.cellId, ...(cell.canonicalRef ? { globalReferences: [cell.canonicalRef] } : {}) },
        {
          fileId: args.fileId,
          ...(file?.book_code ? { bookCode: file.book_code } : {}),
          ...(genre ? { genre } : {}),
        },
        bookGenre,
      )
      for (const effective of resolveEffectiveRules(rules as unknown as ClientStyleRule[], index, coords)) {
        const instruction = effective.rule.instruction.trim()
        if (instruction && !seen.has(instruction)) {
          seen.add(instruction)
          out.push(instruction)
        }
      }
    }
    return out
  } catch (err) {
    console.warn(
      `[style-instructions] read failed for project ${args.projectId}; drafting without style rules:`,
      err instanceof Error ? err.message : err,
    )
    return []
  }
}
