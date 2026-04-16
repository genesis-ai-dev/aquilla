// src/lib/codex-editor/bible-books.ts
const OT = ["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO","ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL"] as const

const NT = ["MAT","MRK","LUK","JHN","ACT","ROM","1CO","2CO","GAL","EPH","PHP","COL","1TH","2TH","1TI","2TI","TIT","PHM","HEB","JAS","1PE","2PE","1JN","2JN","3JN","JUD","REV"] as const

const BOOK_TO_TESTAMENT = new Map<string, "OT" | "NT">([
  ...OT.map((b) => [b, "OT" as const] as [string, "OT"]),
  ...NT.map((b) => [b, "NT" as const] as [string, "NT"]),
])

export function getTestament(abbr: string): "OT" | "NT" | undefined {
  return BOOK_TO_TESTAMENT.get((abbr || "").toUpperCase())
}
