// Legacy `FileSync` Durable Object — retained as an inert stub.
//
// FileSync was the original per-file y-partyserver (Yjs) document runtime
// (DO migration tag `v1`, `new_sqlite_classes`). The v3 architecture moved
// realtime state to `ProjectSync` (AD-1) and the durable record to the D1
// event log, and FileSync's implementation was deleted in the dead-code
// purge. But the class was never removed from the prod worker's DO
// migration lineage, so prod still has live (now-orphaned) FileSync DOs.
//
// Cloudflare refuses to deploy a script that drops a class still backing
// existing DOs unless you ship a `delete-class` migration — which would
// destroy those DOs' stored state. We deliberately do NOT do that: the
// Yjs state is superseded by the event log, but deleting it is data loss
// we don't need to incur. Re-exporting this no-op keeps the class present
// so deploys succeed and the dormant DOs are left untouched. Nothing
// routes to it; any stray request gets a 410 Gone.

import { DurableObject } from "cloudflare:workers"

export class FileSync extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("FileSync is retired; realtime sync moved to ProjectSync.", {
      status: 410,
    })
  }
}
