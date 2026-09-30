/**
 * Does a composer message mean "steer the run" or "control the run"? (AQU-1299)
 *
 * Everything typed at a live Autopilot run used to become a steering
 * *direction* — free text folded into the next passage's drafting prompt — so
 * "stop" never stopped anything, and a direction posted at a parked run woke it
 * back up. That is the opposite of what a person typing "stop" wants.
 *
 * This is the deterministic fast path both the composer and the steering route
 * run, so client and server always agree about what a message meant. It is
 * deliberately conservative: only a SHORT, IMPERATIVE message made of a control
 * verb plus filler counts as a command. Anything with real content in it — an
 * instruction that merely contains the word "stop", like "stop using
 * contractions in narration" — stays a direction and keeps the run going.
 *
 * (The issue also describes an optional server-side model classification for
 * the ambiguous middle. This module is the fast path it would sit behind;
 * nothing here needs a model call.)
 */

export type RunCommandIntent = "direction" | "pause" | "stop"

/** Beyond this many words a message is an instruction, not a command. */
export const MAX_COMMAND_WORDS = 6

/** Hard stop: route to the run's terminate command. */
const STOP_VERBS = new Set(["stop", "halt", "abort", "cancel", "terminate", "quit"])

/** Soft stop at the next passage edge: route to the run's pause command. */
const PAUSE_VERBS = new Set(["pause", "wait", "hold", "hang"])

/**
 * Words that carry no instruction of their own. A command may be padded with
 * these and still be a command ("please stop working on the run now"); a single
 * word from outside this set ("stop *using* contractions") makes it a
 * direction, because that word is the actual instruction.
 */
const FILLER = new Set([
  "a", "all", "and", "any", "autopilot", "drafting", "drafts", "everything",
  "for", "hey", "it", "just", "more", "moment", "now", "ok", "okay", "on",
  "one", "please", "right", "run", "sec", "second", "seconds", "minute",
  "the", "then", "this", "translating", "up", "working", "work", "yourself",
])

/** Leading "@Coordinator" / "@drafter," addressing is not part of the command. */
const LEADING_MENTION_RE = /^(?:@[\p{L}\p{N}_-]+[\s,:]*)+/u

/** Keep letters, digits and intra-word apostrophes/hyphens; everything else
 *  (punctuation, emoji, control chars) is a separator. */
const NON_WORD_RE = /[^\p{L}\p{N}'’-]+/u

function words(raw: string): string[] {
  const withoutMention = raw.trim().replace(LEADING_MENTION_RE, "")
  return withoutMention
    .toLocaleLowerCase("en")
    .split(NON_WORD_RE)
    .map((word) => word.replace(/^['’-]+|['’-]+$/g, ""))
    .filter((word) => word.length > 0)
}

/**
 * Classify a composer message. Returns `"direction"` for anything that is not
 * unambiguously a run command — ambiguity always favours steering, because a
 * mis-read direction only delays a passage while a mis-read stop throws away a
 * run the human still wanted.
 */
export function classifyRunCommandIntent(raw: string): RunCommandIntent {
  const tokens = words(raw)
  if (tokens.length === 0 || tokens.length > MAX_COMMAND_WORDS) return "direction"

  let sawStop = false
  let sawPause = false
  for (const token of tokens) {
    if (STOP_VERBS.has(token)) sawStop = true
    else if (PAUSE_VERBS.has(token)) sawPause = true
    else if (!FILLER.has(token)) return "direction"
  }
  // "stop" beats "pause" when both appear: the stronger command is the one the
  // human cannot undo by waiting.
  if (sawStop) return "stop"
  return sawPause ? "pause" : "direction"
}

/** The run command each non-direction intent routes to. */
export const INTENT_TO_RUN_COMMAND = {
  pause: "pause",
  stop: "terminate",
} as const satisfies Record<Exclude<RunCommandIntent, "direction">, "pause" | "terminate">
