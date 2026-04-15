import type { CodexCell } from "./types";
import type { TranslatableString, CellType } from "@/lib/parsers/types";

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function pad(n: number, width: number): string {
  return Math.floor(n).toString().padStart(width, "0");
}

function formatVttTime(sec: number): string {
  const h = pad(sec / 3600, 2);
  const m = pad((sec % 3600) / 60, 2);
  const s = pad(sec % 60, 2);
  const ms = Math.round((sec - Math.floor(sec)) * 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function contextFor(cell: CodexCell | undefined): string {
  const data = cell?.metadata.data;
  if (!data) return "";
  if (data.startTime !== undefined && data.endTime !== undefined) {
    return `${formatVttTime(data.startTime)} --> ${formatVttTime(data.endTime)}`;
  }
  if (data.book && data.chapter && data.verse) {
    return `${data.book} ${data.chapter}:${data.verse}`;
  }
  return "";
}

function mapType(t: string): CellType {
  if (t === "paratext") return "paratext";
  return "text";
}

export function pairCells(
  source: CodexCell[],
  target: CodexCell[],
  group: string
): TranslatableString[] {
  const sourceById = new Map<string, CodexCell>();
  for (const c of source) sourceById.set(c.metadata.id, c);

  const out: TranslatableString[] = [];
  const seen = new Set<string>();

  for (const t of target) {
    const id = t.metadata.id;
    const s = sourceById.get(id);
    seen.add(id);
    out.push({
      id,
      original: s ? stripHtml(s.value) : "",
      originalHtml: s?.value,
      translated: t.value,
      context: contextFor(s ?? t),
      group,
      type: mapType(t.metadata.type),
    });
  }

  for (const s of source) {
    if (seen.has(s.metadata.id)) continue;
    out.push({
      id: s.metadata.id,
      original: stripHtml(s.value),
      originalHtml: s.value,
      translated: "",
      context: contextFor(s),
      group,
      type: mapType(s.metadata.type),
    });
  }

  return out;
}
