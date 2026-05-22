export interface FlagDefinition {
  /** Human-readable name shown in settings. */
  label: string
  /** One-sentence description shown under the label. */
  description: string
  /** Default when the project has no value stored. */
  default: boolean
}

export const FLAGS = {
  "living-memory-view": {
    label: "Living Memory",
    description:
      "A view of what Codex has learned about this project — instructions, standards, and the examples the AI is drawing from.",
    default: false,
  },
} as const satisfies Record<string, FlagDefinition>

export type FlagKey = keyof typeof FLAGS

export function flagDefault(key: FlagKey): boolean {
  return FLAGS[key].default
}

export function listFlags(): { key: FlagKey; def: FlagDefinition }[] {
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => ({ key, def: FLAGS[key] }))
}
