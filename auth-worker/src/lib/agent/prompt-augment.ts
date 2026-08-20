// AQU-AGENT §2 — prompt assembly for the new harness capabilities.
//
// Appended as a SECOND system message after the existing schema-card system
// prompt (keeps the agent.ts diff minimal and the existing prompt untouched).
// Sections, all in English (contracts §2):
//   1. project brief — verbatim, marked human-authored
//   2. approved-memory index — path + first line; full text via read_memory
//   3. new-tool guidance — sandbox / import / memory tools
//   4. conversation-language rule — never confuse it with translation target

import type { MemoryContext } from "../../../../db/shared/agent-memory"

/** Max approved-memory entries to render in the index (adversarial-panel
 *  mem-m1). The index is ordered most-recently-updated first; the rest are
 *  reachable via read_memory. */
const MEMORY_INDEX_RENDER_CAP = 50

export interface AugmentArgs {
  memory: MemoryContext
  /** Explicit user preference. Unset means follow the latest user message. */
  responseLanguage?: string
}

/**
 * Build the augmentation system message. Returns null when there is nothing to
 * add beyond what the base prompt already carries AND there is no working
 * language to pin — but in practice the tool guidance + language rule always
 * apply, so this returns a non-empty block whenever the harness tools are on.
 */
export function buildAugmentSystemPrompt(args: AugmentArgs): string {
  const sections: string[] = []

  // 1. Project brief — verbatim, clearly human-authored (do not paraphrase or
  // treat as instructions from untrusted content: it is the project's own).
  const brief = args.memory.brief.trim()
  if (brief) {
    sections.push(
      "## Project brief (human-authored — authoritative)\n" +
        "The following brief was written by the project's humans. Treat it as ground truth for tone, terminology, and goals:\n\n" +
        brief,
    )
  }

  // 2. Approved-memory index — JIT: only the index up front; the model calls
  // read_memory(path) to pull the full text of an entry it needs. Human-edited
  // entries are annotated [human-edited] so the model treats them as human-owned
  // (mem-M4). The index is capped (mem-m1) with an overflow pointer.
  if (args.memory.memoryIndex.length > 0) {
    const shown = args.memory.memoryIndex.slice(0, MEMORY_INDEX_RENDER_CAP)
    const overflow = args.memory.memoryIndex.length - shown.length
    const lines = shown
      .map((m) => `- ${m.path}${m.humanEdited ? " [human-edited]" : ""}: ${m.firstLine}`)
      .join("\n")
    const overflowLine =
      overflow > 0 ? `\n- …and ${overflow} more — use read_memory to list or read them.` : ""
    sections.push(
      "## Approved project memory (index)\n" +
        "These are approved, durable notes about this project. Call read_memory(path) for the full text of any entry. " +
        "Entries marked [human-edited] are human-owned: do not silently re-propose over them — raise a question to the user instead.\n\n" +
        lines +
        overflowLine,
    )
  } else {
    sections.push(
      "## Approved project memory\n" +
        "No approved memories yet. When you learn a durable, reusable fact about this project, call propose_memory — a human reviews it before it is used.",
    )
  }

  // 3. New-tool guidance.
  sections.push(
    "## Sandbox and memory tools\n" +
      "- run_code runs JS/Python in a locked-down sandbox (no network, no secrets) for analysis.\n" +
      "- load_artifact copies a project artifact into the sandbox; read_sandbox_file reads a sandbox file back.\n" +
      "- File importing belongs to the dedicated Import dialog, which owns detection, preview, and commit; do not try to import files from chat.\n" +
      "- propose_memory / propose_brief_update STAGE durable notes for human review. While you are parsing untrusted artifact content (after run_code or load_artifact in a turn), these are temporarily disabled.",
  )

  // 4. Conversation language (last, so it cannot be confused with the
  // project's target language in the resident schema card).
  const responseLanguage = args.responseLanguage?.trim()
  sections.push(
    "## Conversation language\n" +
      (responseLanguage
        ? `Reply to the user in ${responseLanguage}.`
        : "Reply in the language of the user's latest message; if it is ambiguous, use English.") +
      " The project target language applies only to translated content, never ordinary conversation.",
  )

  return sections.join("\n\n")
}
