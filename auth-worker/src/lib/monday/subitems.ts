// Files as subitems of the project's row (`fileSubitems` on the mapping).
//
// One row per project keeps the board's overall picture; the files under it
// show where that progress is. Monday keeps every board's subitems on a
// board of their own, with columns of its own, so a push here:
//
//   1. lists the subitems the project's row has now (one query; a subitem
//      deleted in Monday, or a project row made again, simply isn't there),
//   2. resolves the subitems board and its columns once — the columns the
//      project's row has, for the metrics a file has its own value of
//      (SUBITEM_METRICS), plus an Aquilla ID; any the board lacks are added
//      under Aquilla's titles and the result is kept on the mapping,
//   3. adopts a subitem already there for a file (by Aquilla ID, else name),
//      creates the rest, and writes every file's values.
//
// Item links use entity_kind 'subitem', so a link that once had one row per
// file never mistakes those rows for subitems. Files removed from the project
// keep their subitems, as their rows did with one item per file.

import type { Env } from "../../types"
import {
  SUBITEM_METRICS,
  type IntegrationLinkRow,
  type MondayColumnMapping,
  type MondayFileSubitems,
  type MondayMapping,
  type MondayMetricKey,
} from "./types"
import {
  fetchBoardStructure,
  fetchSubitems,
  fetchSubitemsBoardId,
  gqlString,
  normalizeItemName,
  runAliasedMutations,
  type AliasedMutation,
} from "./client"
import { addMissingColumns } from "./columns"
import { buildColumnValues, failingColumnId, type PushEntity } from "./values"
import { saveItemLinks } from "./item-links"

const SUBITEM_KIND = "subitem"

/** Subitem columns, in the order the project's row maps them, Aquilla ID last. */
export function subitemMetricsFor(mapping: MondayMapping): MondayMetricKey[] {
  const wanted = mapping.columns.map((c) => c.metric).filter((m) => SUBITEM_METRICS.includes(m))
  return [...new Set<MondayMetricKey>([...wanted, "external_id"])]
}

/**
 * Write every file as a subitem of `parentItemId`. Answers how many subitems
 * it wrote. Throws like the row push does; a subitem column Monday refuses is
 * dropped from the mapping first, so the next push succeeds without it.
 */
export async function pushFileSubitems(
  env: Env,
  link: IntegrationLinkRow,
  mapping: MondayMapping,
  token: string,
  parentItemId: string,
  files: PushEntity[],
): Promise<number> {
  if (files.length === 0) return 0
  let resolved: Required<MondayFileSubitems> | null = mapping.fileSubitems?.boardId
    ? { boardId: mapping.fileSubitems.boardId, columns: mapping.fileSubitems.columns }
    : null

  const idColumn = resolved?.columns.find((c) => c.metric === "external_id")?.columnId
  const present = await fetchSubitems(token, parentItemId, idColumn)
  if (!resolved) {
    const boardId = present[0]?.boardId ?? (await fetchSubitemsBoardId(token, link.external_id))
    if (boardId) resolved = await resolveSubitemColumns(env, link, mapping, token, boardId)
  }

  // Which subitem holds which file: the saved link while that subitem is
  // still under this row, else one there already by Aquilla ID, else by name.
  const saved = await env.AQUILLA_PG.prepare(
    "SELECT entity_id, external_item_id FROM integration_item_links WHERE link_id = ? AND entity_kind = ?",
  )
    .bind(link.id, SUBITEM_KIND)
    .all<{ entity_id: string; external_item_id: string }>()
  const presentIds = new Set(present.map((s) => s.id))
  const subitemOf = new Map<string, string>()
  for (const row of saved.results ?? []) {
    if (presentIds.has(row.external_item_id)) subitemOf.set(row.entity_id, row.external_item_id)
  }
  const taken = new Set(subitemOf.values())
  const adopted: PushEntity[] = []
  for (const file of files) {
    if (subitemOf.has(file.id)) continue
    const match =
      present.find((s) => !taken.has(s.id) && s.idText === file.id) ??
      present.find((s) => !taken.has(s.id) && normalizeItemName(s.name) === normalizeItemName(file.itemName))
    if (!match) continue
    subitemOf.set(file.id, match.id)
    taken.add(match.id)
    adopted.push(file)
  }
  await saveItemLinks(
    env,
    link.id,
    adopted.map((f) => ({ kind: SUBITEM_KIND, id: f.id, itemId: subitemOf.get(f.id)! })),
  )

  // Create the rest. Before the board has a subitems board this is what makes
  // it, so values can only go with them once it is known.
  const toCreate = files.filter((f) => !subitemOf.has(f.id))
  const createdWithValues = resolved != null
  if (toCreate.length > 0) {
    const columns = resolved?.columns ?? []
    const created = (await runAliasedMutations(
      token,
      toCreate.map((file, i) => ({
        alias: `s${i}`,
        body: `create_subitem(parent_item_id: ${gqlString(parentItemId)}, item_name: ${gqlString(file.itemName)}, column_values: ${gqlString(JSON.stringify(buildColumnValues(columns, file, new Set())))}, create_labels_if_missing: true) { id board { id } }`,
      })),
    )) as Record<string, { id?: string; board?: { id?: string | number } | null } | null>
    const createdLinks = toCreate.map((file, i) => {
      const id = created[`s${i}`]?.id
      if (id == null) throw new Error("create_subitem returned no id")
      subitemOf.set(file.id, String(id))
      return { kind: SUBITEM_KIND, id: file.id, itemId: String(id) }
    })
    await saveItemLinks(env, link.id, createdLinks)
    if (!resolved) {
      const boardId = created.s0?.board?.id ?? (await fetchSubitemsBoardId(token, link.external_id))
      if (boardId == null) throw new Error("Monday made the subitems but named no board for them")
      resolved = await resolveSubitemColumns(env, link, mapping, token, String(boardId))
    }
  }

  const toUpdate = files.filter((f) => !createdWithValues || !toCreate.includes(f))
  if (toUpdate.length > 0 && resolved) {
    const { boardId, columns } = resolved
    const mutations = (excluded: ReadonlySet<string>): AliasedMutation[] =>
      toUpdate.map((file, i) => ({
        alias: `v${i}`,
        // The name goes too, so a file renamed in Aquilla is renamed here.
        body: `change_multiple_column_values(board_id: ${gqlString(boardId)}, item_id: ${gqlString(subitemOf.get(file.id)!)}, column_values: ${gqlString(JSON.stringify({ name: file.itemName, ...buildColumnValues(columns, file, excluded) }))}, create_labels_if_missing: true) { id }`,
      }))
    try {
      await runAliasedMutations(token, mutations(new Set()))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failed = failingColumnId(message, columns)
      if (!failed) throw err
      // The column went from the subitems board. Stop filling it (turning
      // file subitems off and on adds it back), write the rest, and say so.
      await saveResolved(env, link, { boardId, columns: columns.filter((c) => c.columnId !== failed) })
      await runAliasedMutations(token, mutations(new Set([failed])))
      throw new Error(`subitem column '${failed}' failed to write and is no longer filled: ${message}`, {
        cause: err,
      })
    }
  }
  return files.length
}

/**
 * Map the subitems board's columns for this link, adding the missing ones
 * under Aquilla's titles (a column already there under that title, of a type
 * the metric writes, is used as it is — Monday's own "Status" among them).
 * Kept on the link so later pushes don't read the board again.
 */
async function resolveSubitemColumns(
  env: Env,
  link: IntegrationLinkRow,
  mapping: MondayMapping,
  token: string,
  boardId: string,
): Promise<Required<MondayFileSubitems>> {
  const metrics = subitemMetricsFor(mapping)
  const { columns: existing } = await fetchBoardStructure(token, boardId)
  const added = await addMissingColumns(token, boardId, metrics, existing)
  for (const failure of added.failed) {
    console.warn(`[monday] subitem column '${failure.title}' could not be added:`, failure.error)
  }
  const byMetric = new Map([...added.reused, ...added.created].map((c) => [c.metric, c]))
  const columns: MondayColumnMapping[] = metrics.flatMap((metric) => {
    const column = byMetric.get(metric)
    return column ? [{ columnId: column.columnId, columnType: column.columnType, metric }] : []
  })
  const resolved = { boardId, columns }
  await saveResolved(env, link, resolved)
  return resolved
}

/** Keep the resolved subitems board on the link, unless file subitems were turned off meanwhile. */
async function saveResolved(
  env: Env,
  link: IntegrationLinkRow,
  resolved: Required<MondayFileSubitems>,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE integration_links
        SET config = jsonb_set(config, '{fileSubitems}', ?::jsonb)
      WHERE id = ? AND config->'fileSubitems' IS NOT NULL`,
  )
    .bind(JSON.stringify(resolved), link.id)
    .run()
}
