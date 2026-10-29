// integration_item_links writes for the Monday push (rows and subitems).

import type { Env } from "../../types"

/** Rows per item-link upsert statement — keeps a 66-file push to one write. */
const ITEM_LINK_WRITE_BATCH = 100

/** One entity → Monday item: `kind` is 'project', 'file' or a file's 'subitem'. */
export interface ItemLinkPair {
  kind: string
  id: string
  itemId: string
}

/**
 * Upsert the entity → Monday item mappings in one statement per batch
 * (AQU-1828: this used to be one statement per entity, so a first push over a
 * whole Bible issued ~130 DB round trips on top of the Monday calls).
 */
export async function saveItemLinks(env: Env, linkId: string, pairs: ItemLinkPair[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += ITEM_LINK_WRITE_BATCH) {
    const batch = pairs.slice(i, i + ITEM_LINK_WRITE_BATCH)
    const values = batch.map(() => "(?, ?, ?, ?)").join(", ")
    const bindings = batch.flatMap(({ kind, id, itemId }) => [linkId, kind, id, itemId])
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id)
       VALUES ${values}
       ON CONFLICT (link_id, entity_kind, entity_id)
       DO UPDATE SET external_item_id = EXCLUDED.external_item_id`,
    )
      .bind(...bindings)
      .run()
  }
}
