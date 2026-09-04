// Supersession predicate (command registry P1 §3.1). Answers ONE question:
// does the plan's intended end-state ALREADY hold in live state?
//
// Deterministic only — code answers what code can answer. No model call, no
// heuristics, no "close enough". Every rule below is an exact comparison
// against a row the projection already owns. A command kind, or a single event
// inside an EmitEvents batch, that cannot be checked cleanly is NOT satisfied:
// guessing here would silently discard a real plan a human still needs, so the
// bias is always toward false, and a plan counts as satisfied only when EVERY
// command is.
//
// Pure: live state is resolved by the caller (supersede-state.ts) and passed
// in, so the whole rule table is unit-testable without a database.

import { cellKey, laneCellKey } from './cell-keys'
import type { Command } from './commands'
import { deepEqualJson } from './canonical'
import type { EmitEventInput } from './commands-emit-events'
import { normalizeSettings } from '../../../db/shared/projects'

/** One live target cell, as the projection holds it. */
export interface LiveTargetValue {
  value: string
  valueHtml: string | null
}

/**
 * Live state the predicate reads. Every map is keyed the same way the rest of
 * the engine keys cells (laneCellKey / cellKey), so a missing entry means
 * "no such row" — which is always an unsatisfied answer, never an assumption.
 */
export interface SupersedeLiveState {
  /** Target cells by laneCellKey(fileId, cellId, laneId). */
  targetValues: ReadonlyMap<string, LiveTargetValue>
  /** Waived rule ids by cellKey(fileId, cellId) — cell_waivers has no lane. */
  waivedRules: ReadonlyMap<string, ReadonlySet<string>>
  /** Validator usernames by laneCellKey(fileId, cellId, laneId). */
  validators: ReadonlyMap<string, ReadonlySet<string>>
  /** Live `resolved` flag per comment id. Absent = deleted or unknown. */
  commentResolved: ReadonlyMap<string, boolean>
  /** Live project settings blob; undefined when it was not read. */
  settings?: Record<string, unknown>
  /** The username the plan's events would be authored by. Validation is
   *  per-person testimony, so only THIS user's validator row is the plan's
   *  end-state — someone else's validation is a different fact. */
  actorUsername: string
}

/** Per-command verdict, for the commit-path log and the review surface. */
export interface CommandSatisfaction {
  index: number
  kind: string
  satisfied: boolean
  /** Why not — empty when satisfied. */
  reason: string
}

/** True when the plan's intended end-state ALREADY holds in live state. */
export function isPlanSatisfied(commands: readonly Command[], live: SupersedeLiveState): boolean {
  if (commands.length === 0) return false
  return explainPlanSatisfaction(commands, live).every((r) => r.satisfied)
}

/** Per-command breakdown behind isPlanSatisfied — same rules, with reasons. */
export function explainPlanSatisfaction(
  commands: readonly Command[],
  live: SupersedeLiveState,
): CommandSatisfaction[] {
  return commands.map((c, index) => ({ index, kind: c.kind, ...satisfiesCommand(c, live) }))
}

type Verdict = { satisfied: boolean; reason: string }

const YES: Verdict = { satisfied: true, reason: '' }
const no = (reason: string): Verdict => ({ satisfied: false, reason })

function satisfiesCommand(c: Command, live: SupersedeLiveState): Verdict {
  switch (c.kind) {
    case 'SetTranslation': {
      const target = live.targetValues.get(laneCellKey(c.fileId, c.cellId, c.laneId))
      if (!target) return no('no live target cell in this lane')
      if (target.value !== c.value) return no('live target value differs from the planned value')
      // A plan that also carries HTML only lands its end-state when the HTML
      // matches too — an equal plain value over different markup is a real,
      // unapplied change.
      if (c.valueHtml !== undefined && (target.valueHtml ?? '') !== c.valueHtml) {
        return no('live target HTML differs from the planned HTML')
      }
      return YES
    }
    case 'PatchSettings': {
      if (!live.settings) return no('live settings were not resolved')
      // Compare the value that would actually LAND (post-normalization) against
      // the live blob, key by key — a round-trip that normalizes to the stored
      // value is a no-op patch, and a no-op patch is already satisfied.
      const merged: Record<string, unknown> = { ...live.settings }
      for (const op of c.ops) merged[op.key] = op.value
      const normalized = normalizeSettings(merged)
      for (const op of c.ops) {
        if (!deepEqualJson(normalized[op.key], live.settings[op.key])) {
          return no(`settings key "${op.key}" differs from the planned value`)
        }
      }
      return YES
    }
    case 'EmitEvents': {
      for (const [i, e] of c.events.entries()) {
        const verdict = satisfiesEvent(e, live)
        if (!verdict.satisfied) return no(`events[${i}] (${e.kind}): ${verdict.reason}`)
      }
      return YES
    }
    // Creation is not safely idempotent by inspection: a file/project/media
    // link that "looks like" the plan may be a different artifact entirely, and
    // a wrong yes here silently drops work. Never satisfied, by rule.
    case 'PlanImport':
      return no('creation commands are never satisfied by inspection')
    case 'CreateProject':
      return no('creation commands are never satisfied by inspection')
    case 'LinkMedia':
      return no('creation commands are never satisfied by inspection')
    // The deprecated whole-blob replace carries no per-key intent to compare
    // (an absent key is a deletion), so it has no clean check. Use PatchSettings.
    case 'UpdateProjectSettings':
      return no('whole-blob settings replace has no clean per-key check')
    // AQU-1182. RenameFile never reaches here: prepare desugars it into
    // EmitEvents, so a stored plan holds file.rename events, which satisfiesEvent
    // already answers (no clean end-state check). The project-lifecycle commands
    // never reach here either — they are receipt-only and run their own
    // end-state check against the live `projects` row (already archived / already
    // named X), which this predicate has no live state for. Listed explicitly so
    // the table stays a complete map of the command union rather than leaning on
    // the default arm.
    case 'RenameFile':
      return no('file renames have no end-state this predicate can attribute to the plan')
    case 'RenameProject':
    case 'ArchiveProject':
    case 'UnarchiveProject':
      return no('project-lifecycle commands check their own end-state at commit')
    default:
      return no('unknown command kind')
  }
}

/**
 * Per-event rules for an EmitEvents batch. Only the three end-states that are
 * unambiguously readable from the projection are checkable:
 *   cell.waive      → the waiver row for that (cell, rule) exists
 *   cell.validate   → this actor's validator row for that (cell, lane) exists
 *   comment.resolve → the comment's resolved flag already equals the plan's
 * Everything else is false by rule, and the reason says so rather than
 * pretending the check ran.
 */
function satisfiesEvent(e: EmitEventInput, live: SupersedeLiveState): Verdict {
  switch (e.kind) {
    case 'cell.waive': {
      const ruleId = e.payload.ruleId
      if (typeof ruleId !== 'string' || !e.fileId || !e.cellId) return no('incomplete waive reference')
      const rules = live.waivedRules.get(cellKey(e.fileId, e.cellId))
      return rules?.has(ruleId) ? YES : no(`rule "${ruleId}" is not waived on this cell`)
    }
    case 'cell.validate': {
      if (!e.fileId || !e.cellId) return no('incomplete validate reference')
      const names = live.validators.get(laneCellKey(e.fileId, e.cellId, e.laneId))
      return names?.has(live.actorUsername)
        ? YES
        : no(`${live.actorUsername} has no validation on this cell in this lane`)
    }
    case 'comment.resolve': {
      const commentId = e.payload.commentId
      const wanted = e.payload.resolved
      if (typeof commentId !== 'string' || typeof wanted !== 'boolean') {
        return no('incomplete comment.resolve reference')
      }
      const current = live.commentResolved.get(commentId)
      if (current === undefined) return no(`comment ${commentId} is gone`)
      return current === wanted ? YES : no(`comment ${commentId} is not in the planned resolved state`)
    }
    default:
      // cell.unwaive / cell.unvalidate / cell.backtranslation.set /
      // target.cell.repin / comment.create|edit|delete / file.* / assignment.*
      // have no end-state the projection can attribute to THIS plan.
      return no('no clean end-state check for this event kind')
  }
}
