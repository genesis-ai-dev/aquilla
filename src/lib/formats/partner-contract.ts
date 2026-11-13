// How a partner integration puts a format on the shared contract (AQU-2384).
//
// Declared in its own module, not in `./registry.ts`, so that
// `partners/types.ts` can type against it without importing the registry —
// the registry imports the partner registry, and a cycle through
// `partners/types` would be the result otherwise.
//
// Pure types only. No partner module is ever named here or anywhere else in
// generic code; the registry finds these through `partnerIntegrations()`,
// which is a glob that yields nothing once the folders are deleted.

import type { CellData } from "@/hooks/useCells"
import type { FormatFilter } from "./contract"
import type { FormatDescriptor } from "./descriptors"

export interface PartnerFormatFilterRegistration {
  /** Shape, runtime and fidelity of the format — the same table shape the
   *  generic formats use, so one registry can hold both. */
  readonly descriptor: FormatDescriptor
  /** Lazy, so the partner's parser stays code-split. */
  readonly load: () => Promise<FormatFilter<CellData>>
}
