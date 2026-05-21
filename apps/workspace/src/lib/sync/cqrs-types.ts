// Phase 2c-gamma compatibility shim.
//
// The legacy "Cqrs*" type names predate the AD-2 event grammar in
// outbox-types.ts. The outbox + flusher + audit-stats overlay still
// reference them by name; rather than rename across every call site,
// re-export the modern outbox-types under the old names. Drop this
// file entirely once those modules are renamed.

import type {
  OutboxEventKind,
  OutboxEventPayloads,
  OutboxPayloadFor,
  OutboxRawEvent,
} from "./outbox-types"
import { OUTBOX_SCHEMA_VERSION } from "./outbox-types"

export type CqrsEventKind = OutboxEventKind
export type CqrsEventPayloads = OutboxEventPayloads
export type CqrsPayloadFor<K extends OutboxEventKind> = OutboxPayloadFor<K>
export type CqrsRawEvent<K extends OutboxEventKind = OutboxEventKind> = OutboxRawEvent<K>

export const CQRS_SCHEMA_VERSION = OUTBOX_SCHEMA_VERSION
