// The linked table's fields for the shared "what's new since linking" hook
// (useMondayBoardChanges, AQU-804), in its board-and-columns terms. Its own
// module so the hook reads the api functions through their exports.

import type { BoardChangesSource } from "@/components/ProjectSettings/useMondayBoardChanges"
import type { MondayBoardChanges } from "@/lib/monday/api"
import {
  dismissAirtableTableChanges,
  fetchAirtableTableChanges,
  toBoardStructure,
  type AirtableTableChanges,
} from "./api"

export const AIRTABLE_TABLE_CHANGES_SOURCE: BoardChangesSource = {
  read: async (jwt, projectId) => asBoardChanges(await fetchAirtableTableChanges(jwt, projectId)),
  dismiss: async (jwt, projectId, columnIds) =>
    asBoardChanges(await dismissAirtableTableChanges(jwt, projectId, columnIds)),
}

function asBoardChanges(changes: AirtableTableChanges): MondayBoardChanges {
  return {
    structureStale: changes.structureStale,
    newColumns: changes.newFields.map((f) => ({ id: f.id, title: f.name, type: f.type })),
    structure: toBoardStructure(changes.structure),
  }
}
