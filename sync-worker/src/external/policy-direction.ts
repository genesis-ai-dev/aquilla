// AQU-1282: the RESTRICTIVE DIRECTION for the ten policy settings keys.
//
// Until now every agent write naming a policy key was refused outright
// (`permission_denied`), on the sound ground that an agent must not loosen the
// gates that review its own work. But the blanket refusal also blocked the
// TIGHTENING direction — and that is the direction an agent setting up a
// partner project needs most. Setting up a translator in Russia on a
// Biblica-licensed source meant a human going in by hand afterwards to set
// `contributeToGlobalTm: false` and `agentAuthorship: "none"`, after the agent
// had done everything else.
//
// So the rule is now directional rather than absolute: a policy write is
// admitted when it moves the value toward MORE oversight, and refused when it
// moves toward less. It is still ask-mode and still human-approved — this only
// decides which proposals may reach the approval queue at all.
//
// THE SAFE ANSWER IS ALWAYS "REFUSE". Every way of not being able to prove a
// write tightens — an unrecognised value, a value of the wrong type, a key
// this module does not rank — returns a refusal, never a pass. A value a newer
// client invents must not read as permission on an older server (the same rule
// `cellEditingFloorFromSettings` follows).
//
// Ranks below are "restrictiveness": HIGHER means MORE oversight. A write is
// allowed iff rank(next) >= rank(current). Each ladder's rank 0 is the value an
// ABSENT key reads as, so an unset key compares as its real default rather than
// as a hole — except where absence is itself the strictest reading
// (`cellEditingFloor`, where absent means nobody), which the ladder says so.

/** The verdict on one proposed policy-key write. */
export type PolicyDirectionVerdict = { ok: true } | { ok: false; reason: string }

/** A stored value a ladder rung accepts. `null` stands for "key absent /
 *  cleared" — JSON cannot carry undefined, so null is how a caller clears. */
type LadderValue = string | boolean | null

/** An ordered ladder of stored values, loosest first. Each rung lists every
 *  value that reads as THAT rung, so semantically identical spellings (an
 *  absent `cellEditingFloor` and an explicit `"none"` both admit nobody) rank
 *  equal and writing one over the other is a no-op rather than a move. */
interface EnumLadder {
  kind: 'ladder'
  /** Loosest → strictest; inner arrays are equivalent spellings of one rung. */
  rungs: readonly (readonly LadderValue[])[]
  /** Which value an absent key reads as — must appear on some rung. */
  absent: LadderValue
}

/** A numeric key where a HIGHER number means more oversight. */
interface NumericLadder {
  kind: 'number'
  /** Effective value of an absent key. */
  absent: number
  /** Clamp applied before comparing, mirroring what actually gets stored. */
  min?: number
  max?: number
}

/** A set-valued key where ADDING members tightens and removing loosens. */
interface SupersetRule {
  kind: 'superset'
}

type PolicyRule = EnumLadder | NumericLadder | SupersetRule

/**
 * Per-key direction rules. Every member of POLICY_SETTINGS_KEYS must appear
 * here — `policy-direction` tests assert the two lists agree, so a policy key
 * added without a rule fails the build rather than silently defaulting to
 * "allowed".
 */
export const POLICY_DIRECTION_RULES: Readonly<Record<string, PolicyRule>> = {
  // Contributing this project's translations to the global TM is the default;
  // opting out is the restrictive move. true → false allowed, never back.
  contributeToGlobalTm: { kind: 'ladder', rungs: [[true], [false]], absent: true },

  // AQU-1180: `"none"` drops author fields from every agent-facing read.
  // Absent (pseudonymous ids) is the looser reading, so unset → "none" is
  // allowed and "none" → unset is refused.
  agentAuthorship: { kind: 'ladder', rungs: [[null], ['none']], absent: null },

  // Letting a member validate their own work is the permissive default.
  allowSelfValidation: { kind: 'ladder', rungs: [[true], [false]], absent: true },

  // "human" means every memory write waits for a person; "agent-low-risk"
  // lets the agent land some itself. Handing the decision back is tightening.
  agentMemoryAutonomy: {
    kind: 'ladder',
    rungs: [['agent-low-risk'], ['human']],
    absent: 'human',
  },

  // How senior a member must be to validate. Absent reads as "reviewer", the
  // bottom rung (ProjectSettings.tsx baseline).
  validationRoleFloor: {
    kind: 'ladder',
    rungs: [['reviewer'], ['project_lead'], ['maintainer']],
    absent: 'reviewer',
  },

  // AQU-186: absent reads as project_lead, the hard floor — the key exists
  // only to raise it to maintainer.
  harmonize_min_role: {
    kind: 'ladder',
    rungs: [['project_lead'], ['maintainer']],
    absent: 'project_lead',
  },

  // AQU-1068: who may add and remove cells. Unlike every other ladder here the
  // STRICTEST rung is the absent one — an unset key (and the explicit "none")
  // admits nobody, so narrowing from a tier back to "none" is tightening and
  // naming any tier at all is a LOOSENING that stays refused.
  cellEditingFloor: {
    kind: 'ladder',
    rungs: [
      ['commenter'],
      ['reviewer'],
      ['contributor'],
      ['project_lead'],
      ['maintainer'],
      // Absent and the explicit "none" are one rung: both admit nobody.
      [null, 'none'],
    ],
    absent: null,
  },

  // More required validations is more oversight. normalizeSettings clamps
  // validationCount into 1..15 before storing, so rank on the clamped value or
  // a proposed 20 would read as a raise over a stored 15 that it is not.
  validationCount: { kind: 'number', absent: 1, min: 1, max: 15 },
  validationCountAudio: { kind: 'number', absent: 1, min: 1 },

  // Naming more people who must sign off is tightening; dropping any of the
  // named is loosening, whatever else the write adds.
  validationNamedUsers: { kind: 'superset' },
}

/** Rung index of `value`, or null when no rung carries it. An absent/cleared
 *  key resolves to the rule's `absent` value first, so an unset key compares as
 *  its real default rather than as a hole. */
function ladderRank(rule: EnumLadder, value: unknown): number | null {
  // An explicit null is a CLEAR, so it reads as the same rung an absent key
  // does — clearing `agentAuthorship` is the loosening its ladder says it is.
  const resolved = value === undefined || value === null ? rule.absent : (value as LadderValue)
  const index = rule.rungs.findIndex((rung) => rung.includes(resolved))
  return index === -1 ? null : index
}

function numericRank(rule: NumericLadder, value: unknown): number | null {
  if (value === undefined || value === null) return rule.absent
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  let n = Math.floor(value)
  if (rule.min !== undefined) n = Math.max(rule.min, n)
  if (rule.max !== undefined) n = Math.min(rule.max, n)
  return n
}

function asStringSet(value: unknown): Set<string> | null {
  if (value === undefined || value === null) return new Set()
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return null
  return new Set(value as string[])
}

/**
 * Is replacing `currentValue` with `nextValue` on this policy key a move toward
 * MORE oversight (or a no-op)?
 *
 * A key with no rule, an unrecognised value on either side, or a wrong-typed
 * proposal all refuse — see the "safe answer is always refuse" note above. The
 * CURRENT value being unreadable refuses too: a blob this build cannot rank is
 * not one it can prove a write tightens.
 */
export function evaluatePolicyWrite(
  key: string,
  nextValue: unknown,
  currentValue: unknown,
): PolicyDirectionVerdict {
  const rule = POLICY_DIRECTION_RULES[key]
  if (!rule) {
    return { ok: false, reason: `"${key}" is a policy key with no defined restrictive direction` }
  }

  if (rule.kind === 'superset') {
    const next = asStringSet(nextValue)
    if (!next) return { ok: false, reason: `"${key}" expects an array of strings` }
    const current = asStringSet(currentValue)
    if (!current) {
      return { ok: false, reason: `"${key}" currently holds a value this build cannot compare` }
    }
    const dropped = [...current].filter((u) => !next.has(u))
    if (dropped.length > 0) {
      return {
        ok: false,
        reason: `"${key}" may only gain members through the agent surface; this write drops ${dropped
          .map((u) => `"${u}"`)
          .join(', ')}`,
      }
    }
    return { ok: true }
  }

  const nextRank =
    rule.kind === 'number' ? numericRank(rule, nextValue) : ladderRank(rule, nextValue)
  if (nextRank === null) {
    return { ok: false, reason: `"${key}" does not accept this value` }
  }
  const currentRank =
    rule.kind === 'number' ? numericRank(rule, currentValue) : ladderRank(rule, currentValue)
  if (currentRank === null) {
    return { ok: false, reason: `"${key}" currently holds a value this build cannot compare` }
  }
  if (nextRank < currentRank) {
    return {
      ok: false,
      reason: `"${key}" may only move toward MORE oversight through the agent surface; this write loosens it`,
    }
  }
  return { ok: true }
}

/** One refused policy write, for the `permission_denied` details payload. */
export interface PolicyDenial {
  key: string
  reason: string
}
