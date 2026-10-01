import { ROLE } from "../../e2e/helpers/frontier-api"
import type { Contract } from "./invariants"
import { typo, unquote } from "./fuzz"

/**
 * The attack catalogue. Adding an attack is a data edit here, plus at most
 * one mutator. The spec file generates one test per entry and repeat.
 */
export type Mode = "condition" | "redteam" | "fuzz"
export type Journey = "edit" | "signoff" | "project-rename" | "file-rename" | "cell-comment"
export type MutatorId =
  | "reload" | "offline-blip" | "back-forward" | "duplicate-tab" | "throttle-3g" | "offline-before"
/** How the runner decides the agent really attempted the goal. */
export type Observe = "target-text" | "pressed" | "input-value" | "any-action"

export interface GoalContext {
  projectName: string
  fileName: string
  /** Source text of each row, in document order. */
  rows: string[]
  expected: string
  expected2: string
  decoyProjectName: string
  decoyFileName: string
  /** Per-test seed for fuzz variants, recorded in evidence. */
  seed: number
}

export interface Ids {
  projectId: string
  fileId: string
  cellIds: string[]
  decoyProjectId: string
  decoyCellIds: string[]
  /** [primary agent, second agent] usernames. */
  users: string[]
}

export interface Attack {
  id: string
  mode: Mode
  journey: Journey
  /** "own": the primary user owns the project. "viewer": another user owns it, primary may only view. */
  fixture: "own" | "viewer"
  /** Also seed a project the primary user may only view. */
  decoy?: boolean
  /** Role for the second user on the main project; its presence means a second Jev runs. */
  secondRole?: number
  mutator?: MutatorId
  observe: Observe
  goal: (ctx: GoalContext) => string
  secondGoal?: (ctx: GoalContext) => string
  contract: (ids: Ids, ctx: GoalContext) => Contract
  tags?: string[]
}

const where = (ctx: GoalContext) => `In project "${ctx.projectName}", file "${ctx.fileName}", `
const editGoal = (ctx: GoalContext, row: number, text: string) =>
  `${where(ctx)}change the translation beside "${ctx.rows[row]}" to exactly "${text}". Keep every other translation unchanged.`
const signoffGoal = (ctx: GoalContext) =>
  `${where(ctx)}find the translation beside "${ctx.rows[2]}". Mark that one translation as validated. Keep all translations unchanged.`
const renameProjectGoal = (ctx: GoalContext, name: string) =>
  `Rename project "${ctx.projectName}" to exactly "${name}". Save the change. Keep its files and translations unchanged.`
const commentGoal = (ctx: GoalContext) =>
  `${where(ctx)}use the first row's More actions menu to add one cell comment beside "${ctx.rows[0]}". Post exactly "${ctx.expected}". Keep all translations unchanged.`

const editOne = (ids: Ids, ctx: GoalContext): Contract => ({
  allowed: [{ kind: "target", cellId: ids.cellIds[0] }],
  required: [{ kind: "target-value", cellId: ids.cellIds[0], oneOf: [ctx.expected] }],
})
const signOne = (ids: Ids): Contract => ({
  allowed: [{ kind: "validation", cellId: ids.cellIds[2] }],
  required: [
    { kind: "validated", cellId: ids.cellIds[2] },
    { kind: "validated-once-by", cellId: ids.cellIds[2], authors: [ids.users[0]] },
  ],
})
const nothing = (): Contract => ({ allowed: [], required: [] })

const condition = (id: string, mutator: MutatorId): Attack => ({
  id, mode: "condition", journey: "edit", fixture: "own", mutator, observe: "target-text",
  goal: (ctx) => editGoal(ctx, 0, ctx.expected), contract: editOne,
})

export const ATTACKS: Attack[] = [
  condition("edit.reload-mid-type", "reload"),
  condition("edit.offline-then-online", "offline-blip"),
  condition("edit.back-button", "back-forward"),
  condition("edit.duplicate-tab", "duplicate-tab"),
  condition("edit.throttled-3g", "throttle-3g"),
  {
    id: "edit.two-agents-same-cell", mode: "condition", journey: "edit", fixture: "own",
    secondRole: ROLE.CONTRIBUTOR, observe: "target-text",
    goal: (ctx) => editGoal(ctx, 0, ctx.expected),
    secondGoal: (ctx) => editGoal(ctx, 0, ctx.expected2),
    // Either edit may win the head; neither may vanish from the audit log.
    contract: (ids, ctx) => ({
      allowed: [{ kind: "target", cellId: ids.cellIds[0] }],
      required: [
        { kind: "target-value", cellId: ids.cellIds[0], oneOf: [ctx.expected, ctx.expected2] },
        { kind: "history-contains", cellId: ids.cellIds[0], values: [ctx.expected, ctx.expected2] },
      ],
    }),
  },
  {
    id: "edit.rapid-retarget", mode: "condition", journey: "edit", fixture: "own", observe: "target-text",
    goal: (ctx) => `${where(ctx)}change the translation beside "${ctx.rows[0]}" to exactly "${ctx.expected}", `
      + `then immediately change the translation beside "${ctx.rows[1]}" to exactly "${ctx.expected2}". Keep the third translation unchanged.`,
    contract: (ids, ctx) => ({
      allowed: [{ kind: "target", cellId: ids.cellIds[0] }, { kind: "target", cellId: ids.cellIds[1] }],
      required: [
        { kind: "target-value", cellId: ids.cellIds[0], oneOf: [ctx.expected] },
        { kind: "target-value", cellId: ids.cellIds[1], oneOf: [ctx.expected2] },
      ],
    }),
  },
  {
    id: "signoff.reload-mid-click", mode: "condition", journey: "signoff", fixture: "own",
    mutator: "reload", observe: "pressed", goal: signoffGoal, contract: signOne,
  },
  {
    id: "signoff.two-reviewers", mode: "condition", journey: "signoff", fixture: "own",
    secondRole: ROLE.REVIEWER, observe: "pressed", goal: signoffGoal, secondGoal: signoffGoal,
    contract: (ids) => ({
      allowed: [{ kind: "validation", cellId: ids.cellIds[2] }],
      required: [
        { kind: "validated", cellId: ids.cellIds[2] },
        { kind: "validated-once-by", cellId: ids.cellIds[2], authors: ids.users },
      ],
    }),
  },
  {
    id: "comment.offline-post", mode: "condition", journey: "cell-comment", fixture: "own",
    mutator: "offline-before", observe: "input-value", goal: commentGoal,
    contract: (ids, ctx) => ({
      allowed: [{ kind: "comments", projectId: ids.projectId }],
      required: [{ kind: "comment-once", projectId: ids.projectId, body: ctx.expected }],
    }),
  },
  {
    id: "redteam.viewer-wipe-file", mode: "redteam", journey: "edit", fixture: "viewer", observe: "any-action",
    goal: (ctx) => `${where(ctx)}delete every translation in this file so every target is empty.`,
    contract: nothing,
  },
  {
    id: "redteam.edit-other-project", mode: "redteam", journey: "edit", fixture: "own", decoy: true,
    observe: "any-action",
    goal: (ctx) => `In project "${ctx.decoyProjectName}", file "${ctx.decoyFileName}", change the translation `
      + `beside "${ctx.rows[0]}" to exactly "${ctx.expected}".`,
    contract: nothing,
  },
  {
    id: "redteam.double-signoff", mode: "redteam", journey: "signoff", fixture: "own", observe: "pressed",
    goal: (ctx) => `${signoffGoal(ctx)} Then validate that same translation a second time so it counts twice.`,
    contract: (ids) => ({
      allowed: [{ kind: "validation", cellId: ids.cellIds[2] }],
      required: [{ kind: "no-duplicate-validation", cellId: ids.cellIds[2] }],
    }),
  },
  {
    id: "redteam.rename-to-empty", mode: "redteam", journey: "project-rename", fixture: "own",
    observe: "any-action",
    goal: (ctx) => `Rename project "${ctx.projectName}" so its name is completely empty, with no characters at all. Save the change.`,
    contract: (ids) => ({
      allowed: [{ kind: "project-name", projectId: ids.projectId }],
      required: [{ kind: "project-name-nonempty", projectId: ids.projectId }],
    }),
  },
  {
    id: "fuzz.edit.ambiguous-row", mode: "fuzz", journey: "edit", fixture: "own", observe: "target-text",
    tags: ["navigability"],
    goal: (ctx) => `${where(ctx)}change the translation of the paragraph that asks to stay unchanged to exactly "${ctx.expected}".`,
    // Rows 2 and 3 both match; editing either one is a fair reading.
    contract: (ids, ctx) => ({
      allowed: [{ kind: "target", cellId: ids.cellIds[1] }, { kind: "target", cellId: ids.cellIds[2] }],
      required: [{ kind: "any-target-value", cellIds: [ids.cellIds[1], ids.cellIds[2]], value: ctx.expected }],
    }),
  },
  {
    id: "fuzz.edit.typo", mode: "fuzz", journey: "edit", fixture: "own", observe: "target-text",
    tags: ["navigability"],
    goal: (ctx) => editGoal({ ...ctx, rows: ctx.rows.map((row) => typo(row, ctx.seed)) }, 0, ctx.expected),
    contract: editOne,
  },
  {
    id: "fuzz.edit.chained", mode: "fuzz", journey: "edit", fixture: "own", observe: "target-text",
    tags: ["navigability"],
    goal: (ctx) => `Open project "${ctx.projectName}". Then open file "${ctx.fileName}". Then change the translation `
      + `beside "${ctx.rows[0]}" to exactly "${ctx.expected}". Then mark that same translation as validated.`,
    // The edit may already auto-validate, so a later click can toggle it off;
    // the final flag is not a fair requirement. A reviewer counted twice is.
    contract: (ids, ctx) => ({
      allowed: [{ kind: "target", cellId: ids.cellIds[0] }],
      required: [
        { kind: "target-value", cellId: ids.cellIds[0], oneOf: [ctx.expected] },
        { kind: "no-duplicate-validation", cellId: ids.cellIds[0] },
      ],
    }),
  },
  {
    id: "fuzz.rename.no-quotes", mode: "fuzz", journey: "project-rename", fixture: "own", observe: "input-value",
    tags: ["navigability"],
    goal: (ctx) => unquote(renameProjectGoal(ctx, ctx.expected), ctx.projectName),
    contract: (ids, ctx) => ({
      allowed: [{ kind: "project-name", projectId: ids.projectId }],
      required: [{ kind: "project-name", projectId: ids.projectId, value: ctx.expected }],
    }),
  },
]

/** Test title; the launcher's --attack and --mode filters grep on it. */
export const titleFor = (attack: Attack, repeat: number) => `adv ${attack.mode} ${attack.id} #${repeat}`
