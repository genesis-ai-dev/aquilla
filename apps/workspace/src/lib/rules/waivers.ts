import type { RuleWaiver, RuleInfraction } from "@/lib/parsers/types"

export function isWaived(waivers: RuleWaiver[] | undefined, ruleId: string): boolean {
  if (!waivers) return false
  for (const w of waivers) if (w.ruleId === ruleId) return true
  return false
}

export function addWaiver(
  waivers: RuleWaiver[],
  input: { ruleId: string; reason?: string },
  waivedBy: string | undefined,
  waivedAt: string = new Date().toISOString(),
): RuleWaiver[] {
  const filtered = waivers.filter((w) => w.ruleId !== input.ruleId)
  const next: RuleWaiver = { ruleId: input.ruleId, waivedAt }
  if (input.reason) next.reason = input.reason
  if (waivedBy) next.waivedBy = waivedBy
  filtered.push(next)
  return filtered
}

export function removeWaiver(waivers: RuleWaiver[], ruleId: string): RuleWaiver[] {
  const next = waivers.filter((w) => w.ruleId !== ruleId)
  return next.length === waivers.length ? waivers : next
}

export function partitionInfractions(
  infractions: RuleInfraction[],
  waivers: RuleWaiver[] | undefined,
): { active: RuleInfraction[]; waived: RuleInfraction[] } {
  if (!waivers || waivers.length === 0) return { active: infractions, waived: [] }
  const active: RuleInfraction[] = []
  const waived: RuleInfraction[] = []
  for (const inf of infractions) {
    if (isWaived(waivers, inf.ruleId)) waived.push(inf)
    else active.push(inf)
  }
  return { active, waived }
}
