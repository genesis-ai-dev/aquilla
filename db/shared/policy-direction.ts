// Policy-key write direction (AQU-1282 §1).
//
// The policy settings keys govern the oversight machinery that reviews an
// agent's own work, so an agent used to be refused every write to them. That
// blanket refusal also blocked the writes a careful operator WANTS an agent to
// make — turning global-TM contribution off, hiding translator names, raising
// the validation count. The rule is now directional: a write that moves a key
// in its RESTRICTIVE direction is accepted (still ask-mode, still human-
// approved); a write that loosens is refused with a named verdict.
//
// This file is PURE and dependency-free so both workers can import it:
// sync-worker checks PatchSettings at prepare AND commit (recomputed against
// the live blob, so a human loosening in between cannot turn a stale tighten
// into a loosen), and ProjectSetup checks its `settings` block the same way.
//
// Two readings make the table total:
// - An UNSET key reads as its effective default — the value the enforcing
//   reader actually applies when the key is absent (references per key below).
// - A `null` proposed value means "clear to default" (JSON cannot carry
//   undefined; see PatchSettingsOp), so it is compared as that default.
// A no-op write (proposed equals the effective current) counts as `tighten`:
// it changes nothing, so refusing it would only be noise.

export type PolicyDirection = 'tighten' | 'loosen' | 'invalid'

export interface PolicyDirectionVerdict {
  key: string
  direction: PolicyDirection
  current: unknown
  proposed: unknown
  /** Present on `loosen` / `invalid` — names what moved the wrong way. */
  reason?: string
}

/** Documentation-facing summary of each key's restrictive direction. */
export const POLICY_DIRECTION_TABLE: readonly { key: string; restrictiveDirection: string }[] = [
  { key: 'contributeToGlobalTm', restrictiveDirection: 'true → false (unset reads as true)' },
  { key: 'agentAuthorship', restrictiveDirection: '→ "none" (null clears it, which loosens)' },
  { key: 'allowSelfValidation', restrictiveDirection: 'true → false (unset reads as true)' },
  { key: 'agentMemoryAutonomy', restrictiveDirection: '"agent-low-risk" → "human" (unset reads as "human")' },
  { key: 'validationCount', restrictiveDirection: 'a higher integer (unset reads as 1)' },
  { key: 'validationCountAudio', restrictiveDirection: 'a higher integer (unset reads as 1)' },
  { key: 'validationRoleFloor', restrictiveDirection: 'a higher rung: reviewer < project_lead < maintainer (unset reads as reviewer)' },
  { key: 'harmonize_min_role', restrictiveDirection: 'a higher rung: project_lead < maintainer (unset reads as project_lead)' },
  { key: 'cellEditingFloor', restrictiveDirection: 'a higher rung: commenter < reviewer < contributor < project_lead < maintainer < "none" (unset reads as "none" — nobody)' },
  { key: 'validationNamedUsers', restrictiveDirection: 'empty → named, or dropping names from a non-empty list (unset/empty reads as anyone above the floor; adding a name to a non-empty list admits someone new)' },
]

// ── Per-key rules ────────────────────────────────────────────────────────────
//
// Each rule maps a raw stored/proposed value to a comparable rank, or `null`
// when the value is not one this key accepts. `current` that fails to read is
// treated as the default (a garbage stored value has no power to refuse); a
// `proposed` that fails to read is `invalid`.

interface PolicyRule {
  /** Effective value when the key is unset or cleared with null. */
  defaultValue: unknown
  /** Comparable rank; higher = more restrictive. `null` = not accepted. */
  rank: (value: unknown) => number | null
  describe: (value: unknown) => string
}

/** Booleans where `false` is the restrictive value and unset means `true`:
 *  `contributeToGlobalTm` (TM contribution defaults on) and
 *  `allowSelfValidation` (src/lib/review/auto-validation.ts and
 *  sync-worker/src/events/route.ts treat only `=== false` as off). */
const falseIsTighter: PolicyRule = {
  defaultValue: true,
  rank: (v) => (typeof v === 'boolean' ? (v ? 0 : 1) : null),
  describe: String,
}

/** Ordered string enums, listed loosest → tightest. */
function ladder(values: readonly string[], defaultValue: string): PolicyRule {
  return {
    defaultValue,
    rank: (v) => {
      if (typeof v !== 'string') return null
      const i = values.indexOf(v)
      return i === -1 ? null : i
    },
    describe: (v) => JSON.stringify(v),
  }
}

/** Positive integer counts, unset ⇒ 1 (db/shared/projects.ts
 *  validationThreshold clamps to 1..15 and reads a missing value as 1). */
const countRule: PolicyRule = {
  defaultValue: 1,
  rank: (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null),
  describe: String,
}

const RULES: Readonly<Record<string, PolicyRule>> = {
  contributeToGlobalTm: falseIsTighter,
  allowSelfValidation: falseIsTighter,
  // db/shared/agent-memory.ts readAgentMemoryAutonomy: anything but
  // "agent-low-risk" reads as "human".
  agentMemoryAutonomy: ladder(['agent-low-risk', 'human'], 'human'),
  validationCount: countRule,
  validationCountAudio: countRule,
  // sync-worker/src/events/route.ts FLOOR_MAP: no floor stored ⇒ no role check
  // beyond the static reviewer floor on cell.validate.
  validationRoleFloor: ladder(['reviewer', 'project_lead', 'maintainer'], 'reviewer'),
  // sync-worker/src/events/route.ts: project_lead by default, configurable up
  // to maintainer.
  harmonize_min_role: ladder(['project_lead', 'maintainer'], 'project_lead'),
  // db/shared/cell-editing-floor.ts: an absent key admits nobody, the same as
  // the explicit "none" — the tightest rung.
  cellEditingFloor: ladder(
    ['commenter', 'reviewer', 'contributor', 'project_lead', 'maintainer', 'none'],
    'none',
  ),
}

/** `agentAuthorship` is a one-value enum: "none" hides translator identity
 *  from agents; unset (or null) exposes it. Modelled separately because the
 *  exposed state has no string spelling — only absence. */
const AGENT_AUTHORSHIP_EXPOSED = Symbol('exposed')
const agentAuthorshipRule: PolicyRule = {
  defaultValue: AGENT_AUTHORSHIP_EXPOSED,
  rank: (v) => (v === AGENT_AUTHORSHIP_EXPOSED ? 0 : v === 'none' ? 1 : null),
  describe: (v) => (v === AGENT_AUTHORSHIP_EXPOSED ? 'unset (exposed)' : JSON.stringify(v)),
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

/** `validationNamedUsers` is a validator allowlist (sync-worker/src/events/
 *  route.ts: a non-empty list refuses `cell.validate` from anyone not on it;
 *  an empty or absent list refuses nobody). It has no single rank, so it is
 *  compared as sets: the write tightens when it admits no one the current
 *  list does not already admit. */
function namedUsersDirection(current: unknown, proposed: unknown): PolicyDirectionVerdict {
  const key = 'validationNamedUsers'
  const cur = isStringArray(current) ? current : []
  if (proposed !== null && !isStringArray(proposed)) {
    return { key, direction: 'invalid', current, proposed, reason: `${key} expects string[]` }
  }
  const next = proposed ?? []
  const curSet = new Set(cur)
  const nextSet = new Set(next)
  const sameSet = curSet.size === nextSet.size && [...curSet].every((u) => nextSet.has(u))
  if (sameSet) return { key, direction: 'tighten', current, proposed }
  // Empty means "anyone": leaving it is the only tightening move from empty,
  // and reaching it from a named list is always loosening.
  if (curSet.size === 0) return { key, direction: 'tighten', current, proposed }
  if (nextSet.size === 0) {
    return { key, direction: 'loosen', current, proposed, reason: `${key}: clearing the allowlist admits everyone above the floor` }
  }
  const added = [...nextSet].filter((u) => !curSet.has(u))
  if (added.length === 0) return { key, direction: 'tighten', current, proposed }
  return {
    key,
    direction: 'loosen',
    current,
    proposed,
    reason: `${key}: adds validator(s) ${added.map((u) => JSON.stringify(u)).join(', ')} to the allowlist`,
  }
}

/**
 * Classify one policy-key write. `current` is the raw stored value (undefined
 * when the key is absent); `proposed` is the raw op value (null = clear).
 * A key outside the policy set is `invalid` — callers must not treat an
 * unknown key as harmless.
 */
export function policyWriteDirection(
  key: string,
  current: unknown,
  proposed: unknown,
): PolicyDirectionVerdict {
  if (key === 'validationNamedUsers') return namedUsersDirection(current, proposed)
  const rule = key === 'agentAuthorship' ? agentAuthorshipRule : RULES[key]
  if (!rule) {
    return { key, direction: 'invalid', current, proposed, reason: `${key} is not a policy key` }
  }
  const effectiveCurrent = current === undefined || current === null ? rule.defaultValue : current
  const currentRank = rule.rank(effectiveCurrent) ?? rule.rank(rule.defaultValue)
  const effectiveProposed = proposed === null ? rule.defaultValue : proposed
  const proposedRank = rule.rank(effectiveProposed)
  if (currentRank === null || proposedRank === null) {
    return { key, direction: 'invalid', current, proposed, reason: `${key}: ${JSON.stringify(proposed)} is not an accepted value` }
  }
  if (proposedRank >= currentRank) return { key, direction: 'tighten', current, proposed }
  return {
    key,
    direction: 'loosen',
    current,
    proposed,
    reason: `${key}: ${rule.describe(effectiveProposed)} is looser than the current ${rule.describe(effectiveCurrent)}`,
  }
}

/**
 * The verdicts a batch of ops must NOT carry: every op naming a policy key
 * whose write loosens (or cannot be read). Non-policy ops are ignored — they
 * are the caller's business. An empty result means the batch is admissible.
 */
export function loosensPolicy(
  ops: readonly { key: string; value: unknown }[],
  live: Record<string, unknown>,
): PolicyDirectionVerdict[] {
  const out: PolicyDirectionVerdict[] = []
  for (const op of ops) {
    if (!POLICY_DIRECTION_TABLE.some((row) => row.key === op.key)) continue
    const verdict = policyWriteDirection(op.key, live[op.key], op.value)
    if (verdict.direction !== 'tighten') out.push(verdict)
  }
  return out
}
