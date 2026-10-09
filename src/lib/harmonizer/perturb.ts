// Harmonizer eval — controlled damage to clean text (AQU-1675).
//
// A published translation is a passage where every check SHOULD stay quiet.
// Each perturbation below makes exactly the error one check exists to catch,
// at one known verse, so the eval can score both sides: did the check find
// the damage (recall), and did it flag anything in the undamaged passage
// (false alarms)?
//
// Each perturbation returns null when a verse is not a fair test of it (the
// damage would not be the error the check targets), so "eligible" counts are
// real counts, not padding.
//
// English-only patterns (speech verbs, case): these perturb an ENGLISH
// reference translation to manufacture test cases. The checks themselves do
// not depend on English.

import type { HarmonizerCell } from "./types"

export type PerturbationKind = "quote_close" | "reference_switch" | "sentence_broken_off" | "sentence_run_on" | "connective_swap"

export interface Perturbation {
  kind: PerturbationKind
  /** The damaged passage. */
  cells: HarmonizerCell[]
  /** Index of the cell where the check should report. */
  expectCell: number
  expectCheck: string
  note: string
}

const PARTICIPANTS = [
  "Jesus", "Peter", "Simon", "Pilate", "Paul", "Philip", "Thomas", "Judas", "Martha",
  "Mary", "Nicodemus", "Andrew", "John", "James", "Barnabas", "Herod", "Festus", "Agrippa",
]
const SPEECH = "(?:replied|answered|said|asked|told|declared|responded|exclaimed)"
const NAME_THEN_VERB = new RegExp(`\\b(${PARTICIPANTS.join("|")})\\s+(${SPEECH})\\b`)
const VERB_THEN_NAME = new RegExp(`\\b(${SPEECH})\\s+(${PARTICIPANTS.join("|")})\\b`)

function count(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

function replaceCell(cells: readonly HarmonizerCell[], i: number, target: string): HarmonizerCell[] {
  return cells.map((c, j) => (j === i ? { ...c, target } : c))
}

/** Drop the closing mark of a speech that ran across verses and ends at i. */
export function perturbQuoteClose(cells: readonly HarmonizerCell[], i: number): Perturbation | null {
  const t = cells[i].target.trimEnd()
  if (!t.endsWith("”")) return null
  // Only a speech that OPENED in an earlier verse: within one verse the check
  // has nothing cross-cell to see.
  if (count(t, "“") >= count(t, "”")) return null
  // ...and opened INSIDE the passage. A speech that began before the window
  // leaves no open mark the check can see, so dropping its close is invisible
  // by construction — not a fair test.
  let open = 0
  for (const c of cells.slice(0, i)) open = Math.max(0, open + count(c.target, "“") - count(c.target, "”"))
  if (open === 0) return null
  return {
    kind: "quote_close",
    cells: replaceCell(cells, i, t.slice(0, -1)),
    expectCell: i,
    expectCheck: "textual.quotation",
    note: "dropped the closing ” of a multi-verse speech",
  }
}

function namesIn(text: string): Set<string> {
  return new Set(PARTICIPANTS.filter((p) => new RegExp(`\\b${p}\\b`).test(text)))
}

/** "Jesus replied" → "he replied" at a verse whose speaker differs from the
 *  previous verse's. */
export function perturbReferenceSwitch(cells: readonly HarmonizerCell[], i: number): Perturbation | null {
  if (i === 0) return null
  const t = cells[i].target
  const m = NAME_THEN_VERB.exec(t) ?? VERB_THEN_NAME.exec(t)
  if (!m) return null
  const name = NAME_THEN_VERB.test(t) ? m[1] : m[2]
  const prevNames = namesIn(cells[i - 1].target)
  // A switch: the previous verse has a named participant, and not this one.
  if (prevNames.size === 0 || prevNames.has(name)) return null
  // This verse must not name the speaker anywhere else either.
  if (count(t, name) > 1) return null
  const at = t.indexOf(name, m.index)
  const before = t.slice(0, at).trimEnd()
  const capital = before === "" || /[.!?]$/.test(before) || /^[“"]?$/.test(before)
  const pronoun = capital ? "He" : "he"
  return {
    kind: "reference_switch",
    cells: replaceCell(cells, i, t.slice(0, at) + pronoun + t.slice(at + name.length)),
    expectCell: i,
    expectCheck: "textual.reference",
    note: `"${name}" → "${pronoun}" after a verse naming ${[...prevNames].join(", ")}`,
  }
}

const FRAGMENT_OPENER = /^(?:(?:And|But|Now|So|Then|For)\s+)?(?:when|if|as|while|although|though|because|since|after|before|until|whoever|whenever|wherever|unless|once)\b/i

const capitalise = (s: string) => {
  const m = /\p{L}/u.exec(s)
  return m ? s.slice(0, m.index) + m[0].toUpperCase() + s.slice(m.index + 1) : s
}

/** A sentence that runs across i→i+1 gets a full stop at the end of i (and a
 *  capital in i+1, so the deterministic case check cannot catch it). */
export function perturbSentenceBrokenOff(cells: readonly HarmonizerCell[], i: number): Perturbation | null {
  if (i + 1 >= cells.length) return null
  const a = cells[i].target.trimEnd()
  const b = cells[i + 1].target
  if (!a.endsWith(",")) return null
  // A full stop only breaks the target if what it closes cannot stand alone.
  // "Hezekiah was the father of Manasseh, …," stopped early is still a
  // sentence; "And when they came to Golgotha," is not. Require the damaged
  // sentence to open with a subordinator so the case is a real fragment.
  const lastSentence = a.split(/[.!?]["”’]?\s+/).pop() ?? a
  if (!FRAGMENT_OPENER.test(lastSentence.replace(/^[“"‘]+/, ""))) return null
  const first = /\p{L}/u.exec(b)?.[0]
  if (!first || first === first.toUpperCase()) return null
  const damaged = replaceCell(cells, i, a.slice(0, -1) + ".")
  damaged[i + 1] = { ...damaged[i + 1], target: capitalise(b) }
  return {
    kind: "sentence_broken_off",
    cells: damaged,
    expectCell: i,
    expectCheck: "textual.sentence",
    note: "comma at a running sentence's verse end → full stop, next verse capitalised",
  }
}

/** A verse whose sentence ends (in source and target) loses its full stop. */
export function perturbSentenceRunOn(cells: readonly HarmonizerCell[], i: number): Perturbation | null {
  if (i + 1 >= cells.length) return null
  const a = cells[i].target.trimEnd()
  const b = cells[i + 1].target
  if (!/[\p{L}\p{N}]\.$/u.test(a)) return null
  if (!/^\p{Lu}/u.test(b)) return null
  // The source agrees the sentence ends here (Greek full stop or question mark).
  if (!/[.;]$/.test(cells[i].source.trimEnd())) return null
  return {
    kind: "sentence_run_on",
    cells: replaceCell(cells, i, a.slice(0, -1)),
    expectCell: i,
    expectCheck: "textual.sentence",
    note: "dropped a verse-final full stop where the source sentence ends",
  }
}

/** The first few source words, for postpositive particles (γάρ, οὖν, δέ sit
 *  second or third). */
const opening = (source: string) => source.normalize("NFC").split(/\s+/).slice(0, 4).join(" ")

// Whitespace-bounded: JS \b only knows ASCII word characters, so it never
// matches between Greek letters.
const particle = (p: string) => new RegExp(`(?:^|\\s)(?:${p})(?=[\\s,·.;]|$)`, "u")
const SWAPS: { target: RegExp; source: RegExp; to: string; relation: string }[] = [
  { target: /^For /, source: particle("γάρ|γὰρ"), to: "So ", relation: "reason → inference" },
  { target: /^(?:Therefore|So) /, source: particle("οὖν"), to: "For ", relation: "inference → reason" },
  { target: /^But /, source: particle("ἀλλά|ἀλλὰ|ἀλλ’|ἀλλ'"), to: "So ", relation: "contrast → inference" },
]

/** A verse-initial connective whose relation the source confirms is swapped
 *  for one that reverses the logic ("For" → "So" where the Greek has γάρ). */
export function perturbConnectiveSwap(cells: readonly HarmonizerCell[], i: number): Perturbation | null {
  if (i === 0) return null
  const t = cells[i].target
  const src = opening(cells[i].source)
  for (const swap of SWAPS) {
    const m = swap.target.exec(t)
    if (!m || !swap.source.test(src)) continue
    return {
      kind: "connective_swap",
      cells: replaceCell(cells, i, swap.to + t.slice(m[0].length)),
      expectCell: i,
      expectCheck: "textual.connective",
      note: `"${m[0].trim()}" → "${swap.to.trim()}" (${swap.relation})`,
    }
  }
  return null
}

export const PERTURBATIONS: Record<PerturbationKind, (cells: readonly HarmonizerCell[], i: number) => Perturbation | null> = {
  quote_close: perturbQuoteClose,
  reference_switch: perturbReferenceSwitch,
  sentence_broken_off: perturbSentenceBrokenOff,
  sentence_run_on: perturbSentenceRunOn,
  connective_swap: perturbConnectiveSwap,
}
