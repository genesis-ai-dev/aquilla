/**
 * slash-commands.ts — CLI-style shortcuts for the agent composer.
 *
 * A message starting with a known /command expands into a vetted prompt
 * before it hits the wire; the user's bubble keeps the typed command (like a
 * terminal). Everything else — including unknown /words — passes through
 * untouched. Pure so expansion is unit-testable.
 */

export interface SlashCommand {
  name: string
  /** Shown in composer hints, e.g. "/draft MRK 4". */
  usage: string
  description: string
  /** Build the wire prompt from the argument text ("" when none given). */
  expand: (args: string) => string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "draft",
    usage: "/draft [MRK 4]",
    description: "Draft the untranslated cells in a scope",
    expand: (args) =>
      `Draft the untranslated cells in ${args || "the open file"} with the draft tool. ` +
      `Then summarize what you staged, anything the lint flagged, and how much remains.`,
  },
  {
    name: "check",
    usage: "/check [MRK 4]",
    description: "Review translated cells against their source",
    expand: (args) =>
      `Check the translated cells in ${args || "the open file"}: read source against target and look for ` +
      `mistranslations, omissions, additions, and inconsistent terminology. Report findings by ref, ` +
      `and stage corrections for clear errors.`,
  },
  {
    name: "find",
    usage: "/find <text>",
    description: "Search the project and summarize usage",
    expand: (args) =>
      `Search the project for "${args}" and summarize where and how it is used — in the source, ` +
      `the translation, and the termbase. Note any inconsistent renderings.`,
  },
  {
    name: "status",
    usage: "/status",
    description: "Progress summary for the open file",
    expand: () =>
      `Give a progress summary for the open file: how many cells are translated, validated, drafted, ` +
      `stale, or untranslated, and what the most useful next step is.`,
  },
]

/**
 * Expand a leading slash command. Returns null when the text is not a known
 * command (send it as typed). "/find" with no argument returns null too — an
 * empty search is meaningless, not a command.
 */
export function expandSlashCommand(text: string): string | null {
  const m = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const command = SLASH_COMMANDS.find((c) => c.name === m[1])
  if (!command) return null
  const args = (m[2] ?? "").trim()
  if (command.name === "find" && !args) return null
  return command.expand(args)
}
