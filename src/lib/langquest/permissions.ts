// What a LangQuest token lets Aquilla do with one language, for the connect
// screen. LangQuest decides per language (`can`, from GET /me): the token's
// scopes narrowed by the person's role there today. Each capability names the
// scope that grants it, so the screen can say which to tick on /connect.

import type { LangQuestCan, LangQuestScope } from "./types"

export type LangQuestCapability = "readAll" | "readPublished" | "release" | "review" | "externalValues"

export interface CapabilityRow {
  capability: LangQuestCapability
  /** The scope to tick on LangQuest's /connect page for it. */
  scope: LangQuestScope
  granted: boolean
  /** Aquilla does something with it today; the rest are listed so nobody grants them by mistake. */
  usedByAquilla: boolean
}

export function capabilityRows(can: LangQuestCan): CapabilityRow[] {
  return [
    // `read` covers `read:published`, so exactly one of the first two is shown.
    can.read === "published"
      ? { capability: "readPublished", scope: "read:published", granted: true, usedByAquilla: true }
      : { capability: "readAll", scope: "read", granted: can.read === "all", usedByAquilla: true },
    { capability: "release", scope: "release", granted: can.release, usedByAquilla: true },
    { capability: "review", scope: "review", granted: can.review, usedByAquilla: false },
    {
      capability: "externalValues",
      scope: "external_values",
      granted: can.externalValues.read || can.externalValues.write,
      usedByAquilla: false,
    },
  ]
}

/** Read-only or read/write, as the connect screen summarizes the token. */
export function accessLevel(can: LangQuestCan): "none" | "published" | "readOnly" | "readWrite" {
  if (can.read == null) return "none"
  if (can.release || can.review || can.externalValues.write) return "readWrite"
  return can.read === "published" ? "published" : "readOnly"
}

/** A link needs at least read access; a language the token cannot read is listed but disabled. */
export const canLinkLanguage = (can: LangQuestCan): boolean => can.read != null
