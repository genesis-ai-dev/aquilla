// AQU-1075: which project settings a linked downstream copies from its upstream.
//
// The choice and the per-field detach live in the settings JSON
// (`inheritedFromLink`), not in a new column. A database without a migration
// still carries them, before and after AQU-1616 fills `source_link_lane_id`.
//
// This module is the shared vocabulary. It imports nothing that touches a
// database or the DOM, so the settings UI and the server write path cannot
// drift about which keys travel.

export const INHERIT_FIELD_IDS = [
  "translationBrief",
  "knowledgeDocs",
  "workflowPolicy",
  "livingMemory",
  "smartQuotes",
  "systemPrompt",
] as const

export type InheritFieldId = (typeof INHERIT_FIELD_IDS)[number]

/**
 * What a new link receives when the request omits the choice.
 * AI instructions stay off: they usually name the language pair.
 */
export const INHERIT_DEFAULTS: Record<InheritFieldId, boolean> = {
  translationBrief: true,
  knowledgeDocs: true,
  workflowPolicy: true,
  livingMemory: false,
  smartQuotes: false,
  systemPrompt: false,
}

/** Top-level settings keys each field copies. Knowledge documents are rows, not a key. */
export const INHERIT_FIELD_KEYS: Record<InheritFieldId, readonly string[]> = {
  translationBrief: ["translationBrief"],
  knowledgeDocs: [],
  workflowPolicy: [
    "validationCount",
    "validationCountAudio",
    "validationRoleFloor",
    "validationRoleFloorAudio",
    "allowSelfValidation",
    "allowSelfValidationAudio",
    "autopilotEnabled",
    "agentMode",
    "countStructuralCells",
    "rulePenalties",
  ],
  livingMemory: ["livingMemoryEntries"],
  smartQuotes: ["smartQuotes"],
  systemPrompt: ["systemPrompt"],
}

/**
 * Explicitly never copied, even when a neighbouring workflow key is.
 * Named validators are people on the upstream project. Lanes, languages,
 * rules, terminology, direction, speech, and media timing belong to that
 * project, not to the next one in the chain.
 */
export const INHERIT_NEVER_KEYS = [
  "validationNamedUsers",
  "validationNamedUsersAudio",
  "sourceLanguage",
  "targetLanguage",
  "targetLanes",
  "archivedLanes",
  "rules",
  "terminology",
  "termMatching",
  "alignmentSeeds",
  "sourceTextDirection",
  "targetTextDirection",
  "ttsSettings",
  "dcsUpstream",
  "audioTimingMode",
  "timingLocked",
] as const

export const INHERITED_FROM_LINK_KEY = "inheritedFromLink"

export interface InheritedFromLink {
  receive: Record<InheritFieldId, boolean>
  detached: Partial<Record<InheritFieldId, boolean>>
  /** Upstream knowledge-doc id → this project's copy. Server-owned. */
  knowledgeDocCopies?: Record<string, string>
}

export function emptyInheritedFromLink(
  receive: Record<InheritFieldId, boolean> = { ...INHERIT_DEFAULTS },
): InheritedFromLink {
  return { receive: { ...receive }, detached: {} }
}

export function isInheritFieldId(value: string): value is InheritFieldId {
  return (INHERIT_FIELD_IDS as readonly string[]).includes(value)
}

export function isReceiving(config: InheritedFromLink, field: InheritFieldId): boolean {
  return config.receive[field] === true && config.detached[field] !== true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** A stored blob that is not the shape we write is treated as "not inheriting". */
export function parseInheritedFromLink(raw: unknown): InheritedFromLink | null {
  if (!isRecord(raw) || !isRecord(raw.receive)) return null
  const receive = { ...INHERIT_DEFAULTS }
  for (const id of INHERIT_FIELD_IDS) {
    if (typeof raw.receive[id] === "boolean") receive[id] = raw.receive[id]
  }
  const detached: Partial<Record<InheritFieldId, boolean>> = {}
  if (isRecord(raw.detached)) {
    for (const id of INHERIT_FIELD_IDS) {
      if (raw.detached[id] === true) detached[id] = true
    }
  }
  const copies: Record<string, string> = {}
  if (isRecord(raw.knowledgeDocCopies)) {
    for (const [upstreamId, downstreamId] of Object.entries(raw.knowledgeDocCopies)) {
      if (typeof downstreamId === "string" && downstreamId.length > 0 && upstreamId.length > 0) {
        copies[upstreamId] = downstreamId
      }
    }
  }
  return {
    receive,
    detached,
    ...(Object.keys(copies).length > 0 ? { knowledgeDocCopies: copies } : {}),
  }
}

/**
 * Overlay a link-time or settings-time choice onto the defaults (or onto the
 * stored choice). Omitted booleans keep the base. Knowledge-doc ids are never
 * taken from the caller.
 */
export function mergeInheritChoice(
  base: InheritedFromLink | null,
  incoming: unknown,
): InheritedFromLink {
  const stored = base ?? emptyInheritedFromLink()
  const parsed = parseInheritedFromLink(incoming)
  if (!parsed) return stored
  return {
    receive: parsed.receive,
    detached: parsed.detached,
    ...(stored.knowledgeDocCopies ? { knowledgeDocCopies: stored.knowledgeDocCopies } : {}),
  }
}

export function inheritChoiceFromRequest(
  raw: Partial<Record<InheritFieldId, boolean>> | null | undefined,
): Record<InheritFieldId, boolean> {
  const receive = { ...INHERIT_DEFAULTS }
  if (!raw) return receive
  for (const id of INHERIT_FIELD_IDS) {
    if (typeof raw[id] === "boolean") receive[id] = raw[id]
  }
  return receive
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

export function sameSetting(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
): boolean {
  const leftHas = hasKey(left, key)
  const rightHas = hasKey(right, key)
  if (leftHas !== rightHas) return false
  if (!leftHas) return true
  return JSON.stringify(left[key]) === JSON.stringify(right[key])
}

export function copiedSettingsKeys(): string[] {
  return INHERIT_FIELD_IDS.flatMap((id) => [...INHERIT_FIELD_KEYS[id]])
}

/**
 * The downstream blob after an upstream save, or null when nothing this
 * downstream still receives actually changed. The downstream's own
 * `inheritedFromLink` is left as it was.
 */
export function applyUpstreamSettingsCopy(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  downstream: Record<string, unknown>,
): Record<string, unknown> | null {
  const config = parseInheritedFromLink(downstream[INHERITED_FROM_LINK_KEY])
  if (!config) return null
  const next: Record<string, unknown> = { ...downstream }
  let changed = false
  for (const field of INHERIT_FIELD_IDS) {
    if (!isReceiving(config, field)) continue
    for (const key of INHERIT_FIELD_KEYS[field]) {
      if (sameSetting(before, after, key)) continue
      if (hasKey(after, key)) next[key] = after[key]
      else delete next[key]
      changed = true
    }
  }
  return changed ? next : null
}

/** Copy every key a choice currently receives, including keys the upstream lacks. */
export function copyReceivedSettings(
  upstream: Record<string, unknown>,
  downstream: Record<string, unknown>,
  config: InheritedFromLink,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...downstream, [INHERITED_FROM_LINK_KEY]: config }
  for (const field of INHERIT_FIELD_IDS) {
    if (!isReceiving(config, field)) continue
    for (const key of INHERIT_FIELD_KEYS[field]) {
      if (hasKey(upstream, key)) next[key] = upstream[key]
      else delete next[key]
    }
  }
  return next
}
