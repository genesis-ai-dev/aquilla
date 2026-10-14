/**
 * Smoke-render stub for the apiRev 7 surfaces (host-handlers-files.ts): an
 * in-memory project with one tagged reference file and an in-memory data
 * store, so a builder's importer / editor / exporter can run end to end in
 * the pre-save check without a network or a database.
 */

import type { ToolDataDoc, ToolFileView, ToolFilesHostData, ToolRefCell } from "./host-handlers-files"

const SAMPLE_FILES: ToolFileView[] = [
  { fileId: "f1", name: "MAT", cellCount: 4, kind: "normal", tags: ["book:MAT"], group: "sample:MAT", owner: null, meta: null },
  { fileId: "f3", name: "MAT notes", cellCount: 2, kind: "normal", tags: ["notes", "book:MAT"], group: "sample:MAT", owner: "smoke", meta: { source: "example" } },
  { fileId: "f4", name: "MAT original", cellCount: 2, kind: "reference", tags: ["original", "book:MAT"], group: "sample:MAT", owner: "smoke", meta: null },
]

const REF_CELLS: ToolRefCell[] = [
  { fileId: "f1", cellId: "c1", ref: "MAT 1:1", source: "The book of the genealogy of Jesus Christ", target: "Libro de la genealogía de Jesucristo", sourceHtml: null, targetHtml: null, type: "verse", metadata: null, validated: true },
  { fileId: "f3", cellId: "n1", ref: "MAT 1:1", source: "**book of the genealogy** — a record of ancestors", target: "", sourceHtml: null, targetHtml: null, type: "text", metadata: { Quote: "Βίβλος γενέσεως", Occurrence: "1" }, validated: false },
  { fileId: "f4", cellId: "o1", ref: "MAT 1:1", source: "Βίβλος γενέσεως Ἰησοῦ Χριστοῦ", target: "", sourceHtml: null, targetHtml: null, type: "verse", metadata: { words: [{ text: "Βίβλος", lemma: "βίβλος", strong: "G09760" }] }, validated: false },
]

export function stubFilesData(populated: boolean): ToolFilesHostData {
  const docs = new Map<string, ToolDataDoc>()
  const key = (ns: string, coll: string, id: string) => `${ns}|${coll}|${id}`
  return {
    listFilesFiltered: async (filter) =>
      (populated ? SAMPLE_FILES : []).filter(
        (f) =>
          (!filter.kind || f.kind === filter.kind) &&
          (!filter.group || f.group === filter.group) &&
          (!filter.tags || filter.tags.every((t) => f.tags?.includes(t))),
      ),
    upsertFile: async (spec) => ({
      fileId: `ext-${spec.key}`,
      created: true,
      creates: spec.cells.length,
      commits: 0,
      deletes: 0,
      unchanged: 0,
      cellIds: Object.fromEntries(spec.cells.map((c) => [c.key, `cell-${c.key}`])),
    }),
    setFileMeta: async (fileId, patch) => ({
      ...(SAMPLE_FILES.find((f) => f.fileId === fileId) ?? { fileId, name: fileId, cellCount: 0, kind: "normal", tags: [], group: null, owner: null, meta: null }),
      ...(patch.tags ? { tags: patch.tags } : {}),
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.group !== undefined ? { group: patch.group } : {}),
      ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
      ...(patch.name ? { name: patch.name } : {}),
    }),
    fileSource: async (fileId) => (populated && fileId === "f1" ? { text: "\\id MAT\n\\c 1\n\\v 1 The book of the genealogy of Jesus Christ\n" } : null),
    fileGroup: async (fileId) => {
      const self = populated ? SAMPLE_FILES.find((f) => f.fileId === fileId) : undefined
      return self?.group ? { key: self.group, files: SAMPLE_FILES.filter((f) => f.group === self.group) } : null
    },
    cellsByRef: async (query) => {
      if (!populated) return {}
      const out: Record<string, ToolRefCell[]> = {}
      for (const c of REF_CELLS) {
        const hit = query.refs.length > 0 ? query.refs.includes(c.ref) : c.ref.startsWith(query.prefix ?? "")
        const inFiles = query.fileIds ? query.fileIds.includes(c.fileId) : (query.tags ?? []).every((t) => SAMPLE_FILES.find((f) => f.fileId === c.fileId)?.tags?.includes(t))
        if (hit && inFiles) (out[c.ref] ??= []).push({ ...c })
      }
      return out
    },
    dataGet: async (ns, coll, id) => docs.get(key(ns, coll, id)) ?? null,
    dataPut: async (ns, coll, id, doc, anchor) => {
      docs.set(key(ns, coll, id), {
        id,
        doc,
        anchor: anchor ? { ...anchor, eventId: "e-smoke" } : null,
        drift: anchor ? "current" : null,
        ref: anchor ? "MAT 1:1" : null,
        updatedBy: "smoke",
        updatedAt: Date.now(),
      })
      return { id, version: `v${docs.size}` }
    },
    dataQuery: async (ns, coll, filter) =>
      [...docs.entries()]
        .filter(([k]) => k.startsWith(`${ns}|${coll}|`))
        .map(([, d]) => d)
        .filter((d) => (!filter.anchorFileId || d.anchor?.fileId === filter.anchorFileId) && (!filter.anchorCellIds || (d.anchor && filter.anchorCellIds.includes(d.anchor.cellId))) && (!filter.ref || d.ref === filter.ref)),
    dataDelete: async (ns, coll, id) => docs.delete(key(ns, coll, id)),
    actionProgress: async () => true,
    actionDone: async () => true,
    exportDeliver: async () => true,
  }
}
