// A Bible data finding as flat strings (AQU-1688, shared by AQU-1690).
//
// The SPA rule engine carries a finding's reason, params and pack evidence as
// `RuleInfraction.reasonParams`; autopilot stores the same strings as the
// value of a draft's `bkp:` verdict, so the review UI formats both with one
// function (src/lib/bible-data/check-messages.ts). Codes and pack data only,
// never prose.
//
// Relative imports only, no DOM: shared with the workers.

import type { BibleCheckEvidence, BibleCheckFinding } from './types'

/** A finding as flat strings: its params, `kind` (the reason), `evidence` and the evidence fields. */
export function bibleReasonParams(finding: BibleCheckFinding): Record<string, string> {
  const params: Record<string, string> = { ...finding.params, kind: finding.reason, evidence: finding.evidence.kind }
  if (finding.approximate) params.approximate = 'true'
  const evidence = finding.evidence
  if (evidence.kind === 'speech') {
    params.startRef = evidence.startRef
    params.startWord = String(evidence.startWord)
    params.endRef = evidence.endRef
    params.endWord = String(evidence.endWord)
    params.speakerSources = evidence.speakerSources.join(',')
    params.speakerConf = String(evidence.speakerConf)
  } else {
    params.refs = evidence.refs.join(',')
    // AQU-1697: the pack data each kind adds.
    if (evidence.kind === 'number') {
      params.startWord = String(evidence.startWord)
      params.endWord = String(evidence.endWord)
    } else if (evidence.kind === 'variant') {
      params.passage = evidence.passage
    } else if (evidence.kind === 'pericope') {
      params.title = evidence.title
    } else {
      Object.assign(params, packBEvidence(evidence))
    }
  }
  return params
}

/** AQU-1699: the pack data each check-pack-B evidence kind adds. */
function packBEvidence(evidence: BibleCheckEvidence): Record<string, string> {
  switch (evidence.kind) {
    case 'mention':
      return { entity: evidence.entity, word: String(evidence.word), mention: evidence.mention }
    case 'no-mention':
    case 'name-variants':
      return { entity: evidence.entity }
    case 'second-person':
      return { number: evidence.number }
    case 'clusivity':
      // Labels, which may hold commas: joined for display as they are.
      return { word: String(evidence.word), referents: evidence.referents.join('; '), addressees: evidence.addressees.join('; ') }
    case 'decision':
      return { decision: evidence.key }
    case 'group':
      return { entity: evidence.entity, size: String(evidence.size), word: String(evidence.word) }
    case 'divine-name':
      return { word: String(evidence.word) }
    case 'repeated-quotation':
      return { other: evidence.other, similarity: String(evidence.similarity) }
    default:
      return {}
  }
}

/** Flat params as one string, for a draft's verdict value. */
export function encodeBibleParams(params: Readonly<Record<string, string>>): string {
  return new URLSearchParams(Object.entries(params)).toString()
}

/** The params a verdict value carries; empty for "flag" or anything else that is not encoded params. */
export function decodeBibleParams(value: string | null | undefined): Record<string, string> {
  if (!value || !value.includes('=')) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of new URLSearchParams(value)) out[key] = val
  return out
}
