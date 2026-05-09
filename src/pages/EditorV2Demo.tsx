/**
 * Dev-only end-to-end exercise of the new editor stack: TipTap +
 * placeholder extensions + local-store persistence + outbox.
 *
 * The /dev/local-store demo proved SQLite-WASM and the outbox in
 * isolation; this route proves the full editor flow:
 *   user types → TipTap update → debounced serialize →
 *   upsertCell + enqueueOutboxRecord → reload re-hydrates from OPFS.
 *
 * See e2e/specs/local-store/editor-v2.smoke.spec.ts.
 */

import { useEffect, useRef, useState } from "react"
import {
  enqueueOutboxRecord,
  getCellsByScope,
  getProjectMeta,
  ingestSnapshot,
  listPending,
  LocalStore,
  MIGRATIONS,
  upsertCell,
  type CellRow,
} from "@/lib/local-store"
import {
  TranslatedEditorV2,
} from "@/components/codex-editor-v2/TranslatedEditorV2"
import type {
  PMDoc,
  TagDictionary,
} from "@/lib/codex-editor-v2"

const PROJECT_ID = "demo-v2"
const SCOPE_ID = "scope-1"
const DB_NAME = "codex-demo-v2"

const DICT: TagDictionary = {
  g1: { kind: "style", origin: { format: "usfm", marker: "\\add" } },
  f1: { kind: "ph", ref: { cell_id: "demo-v2:fn1" } },
}

const FIXTURE_LINES: string[] = [
  JSON.stringify({
    type: "snapshot_meta",
    snapshot_seq: 1,
    project_id: PROJECT_ID,
    generated_at: 0,
  }),
  JSON.stringify({
    type: "project_meta",
    project_id: PROJECT_ID,
    org_id: "demo-org",
    name: "Demo (Editor v2)",
    library_doc_id: "demo-lib",
    bound_version_id: "demo-ver",
    source_lang: "eng",
    target_lang: "spa",
  }),
  ...[
    "In the beginning God created the heavens and the earth.",
    "And the earth was without form, and void.",
    "Translate {g1}this part{/g1} carefully{f1}.",
  ].map((text, i) =>
    JSON.stringify({
      type: "cell",
      id: `${PROJECT_ID}:cell-${i + 1}`,
      project_id: PROJECT_ID,
      scope_id: SCOPE_ID,
      address: `cell-${i + 1}`,
      ord: i,
      kind: "text",
      parent_cell_id: null,
      source_text: text,
      source_text_hash: `h-${i + 1}`,
      source_version_id: "demo-ver",
      translation_text: "",
      tag_dictionary: i === 2 ? JSON.stringify(DICT) : "{}",
      status: "empty",
      approved_at_version: null,
      locked_by_user_id: null,
      version: 0,
      last_edited_by: null,
      last_edited_at: null,
      seq: 1,
      created_at: 0,
      updated_at: 0,
      org_id: "demo-org",
      source_lang: "eng",
      target_lang: "spa",
      format_meta: "{}",
    }),
  ),
]

async function* asLines(arr: string[]): AsyncIterable<string> {
  for (const line of arr) yield line
}

function dictForCell(cell: CellRow): TagDictionary {
  try {
    const parsed = JSON.parse(cell.tag_dictionary) as TagDictionary
    return parsed
  } catch {
    return {}
  }
}

export default function EditorV2Demo() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const [cells, setCells] = useState<CellRow[]>([])
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const storeRef = useRef<LocalStore | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await LocalStore.open({ name: DB_NAME })
        await s.migrate(MIGRATIONS)
        const existing = await getProjectMeta(s, PROJECT_ID)
        if (!existing) {
          await ingestSnapshot(s, asLines(FIXTURE_LINES))
        }
        if (cancelled) {
          await s.close()
          return
        }
        storeRef.current = s
        const rows = await getCellsByScope(s, PROJECT_ID, SCOPE_ID)
        const outbox = await listPending(s)
        setStore(s)
        setCells(rows)
        setPending(outbox.length)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
      if (storeRef.current) void storeRef.current.close()
    }
  }, [])

  async function handleCommit(
    cell: CellRow,
    text: string,
    _doc: PMDoc,
  ): Promise<void> {
    const s = storeRef.current
    if (!s) return
    if (text === cell.translation_text) return
    const newVersion = cell.version + 1
    const updated: CellRow = {
      ...cell,
      translation_text: text,
      version: newVersion,
      updated_at: Date.now(),
    }
    await upsertCell(s, updated)
    await enqueueOutboxRecord(s, {
      local_id: `${cell.id}@v${newVersion}-${Date.now()}`,
      project_id: cell.project_id,
      endpoint: `/projects/${cell.project_id}/cells/${cell.id}`,
      payload: JSON.stringify({
        kind: "cell.set_translation",
        translation_text: text,
        expected_version: cell.version,
      }),
      expected_version: cell.version,
      created_at: Date.now(),
    })
    setCells((prev) => prev.map((c) => (c.id === cell.id ? updated : c)))
    const outbox = await listPending(s)
    setPending(outbox.length)
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-red-600" data-testid="editor-v2-error">
        {error}
      </div>
    )
  }
  if (!store) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-gray-600" data-testid="editor-v2-loading">
        Opening local SQLite database…
      </div>
    )
  }

  return (
    <div data-testid="editor-v2-demo" className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-1">Editor v2 Demo</h1>
      <p className="text-sm text-gray-600 mb-4">
        TipTap with placeholder extensions, persisted directly to SQLite-WASM
        + outbox. No Y.Doc binding. Type and reload — the edits persist.
      </p>
      <div
        data-testid="pending-count"
        className="mb-4 inline-block rounded bg-amber-50 border border-amber-200 px-2 py-1 text-xs text-amber-800"
      >
        Pending mutations: <span data-testid="pending-count-value">{pending}</span>
      </div>
      <ul className="divide-y border rounded">
        {cells.map((cell) => (
          <li key={cell.id} data-testid={`cell-${cell.id}`} className="px-3 py-3">
            <div className="text-xs text-gray-500 mb-1">{cell.address}</div>
            <div className="text-sm mb-2 text-gray-700">{cell.source_text}</div>
            <TranslatedEditorV2
              cellId={cell.id}
              translationText={cell.translation_text}
              tagDictionary={dictForCell(cell)}
              onCommit={(text, doc) => {
                void handleCommit(cell, text, doc)
              }}
              className="prose prose-sm max-w-none w-full min-h-[40px] px-2 py-1 text-sm rounded border border-gray-200 hover:bg-muted/40 focus:bg-muted/30 focus:outline-none"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
