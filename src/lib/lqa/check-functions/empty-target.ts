import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Source has content but the translation is empty"

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  if (source.trim() === "") return null
  if (target.trim() !== "") return null
  return [{ side: "target", start: 0, end: 0, matchedText: "" }]
}
