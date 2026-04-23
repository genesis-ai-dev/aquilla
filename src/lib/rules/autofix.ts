import type { RuleAutofix } from "@/lib/parsers/types"

export function applyRegexFix(fix: RuleAutofix, translated: string): string {
  const re = new RegExp(fix.pattern, fix.flags)
  return translated.replace(re, fix.replacement)
}

// Literal replace-all. Does NOT treat `find` as a regex.
export function applyLiteralFix(find: string, replace: string, translated: string): string {
  if (find.length === 0) return translated
  return translated.split(find).join(replace)
}
