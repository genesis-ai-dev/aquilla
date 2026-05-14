import type { EditHistory } from "./types";
import type { CellHistoryEntry } from "@/lib/parsers/types";

const LLM_TYPES = new Set(["llm-edit", "llm-generation"]);

export function mapEditHistory(edits: EditHistory[]): CellHistoryEntry[] {
  const mapped: CellHistoryEntry[] = [];
  for (const e of edits) {
    if (!e.editMap || e.editMap[0] !== "value") continue;
    const validated = !!e.validatedBy?.some(v => !v.isDeleted);
    mapped.push({
      timestamp: new Date(e.timestamp).toISOString(),
      value: typeof e.value === "string" ? e.value : String(e.value ?? ""),
      source: LLM_TYPES.has(e.type) ? "llm" : "human",
      author: e.author || "git-import",
      validated,
    });
  }
  mapped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return mapped;
}
