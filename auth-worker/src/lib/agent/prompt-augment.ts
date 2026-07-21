// AQU-AGENT §2 — prompt assembly for the new harness capabilities.
//
// Appended as a SECOND system message after the existing schema-card system
// prompt (keeps the agent.ts diff minimal and the existing prompt untouched).
// Sections, all in English (contracts §2):
//   1. project brief — verbatim, marked human-authored
//   2. approved-memory index — path + first line; full text via read_memory
//   3. new-tool guidance — sandbox / import / memory tools
//   4. language rule — scaffolding is English; reply in the working language

import type { MemoryContext } from "./memory-context-stub"

/** Fallback phrasing when no working language is resolvable from settings. */
const WORKING_LANGUAGE_FALLBACK = "the project's working language"

export interface AugmentArgs {
  memory: MemoryContext
  /** Project working (target) language, if resolvable; else the fallback. */
  workingLanguage?: string
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
  // read_memory(path) to pull the full text of an entry it needs.
  if (args.memory.memoryIndex.length > 0) {
    const lines = args.memory.memoryIndex.map((m) => `- ${m.path}: ${m.firstLine}`).join("\n")
    sections.push(
      "## Approved project memory (index)\n" +
        "These are approved, durable notes about this project. Call read_memory(path) for the full text of any entry:\n\n" +
        lines,
    )
  } else {
    sections.push(
      "## Approved project memory\n" +
        "No approved memories yet. When you learn a durable, reusable fact about this project, call propose_memory — a human reviews it before it is used.",
    )
  }

  // 3. New-tool guidance.
  sections.push(
    "## Sandbox, import, and memory tools\n" +
      "- run_code runs JS/Python in a locked-down sandbox (no network, no secrets) for parsing/inspecting files.\n" +
      "- load_artifact copies a project artifact into the sandbox; read_sandbox_file reads a sandbox file back.\n" +
      "- plan_import STAGES a file import as a changeset for human approval — it never writes directly.\n" +
      "- propose_memory / propose_brief_update STAGE durable notes for human review. While you are parsing untrusted artifact content (after run_code or load_artifact in a turn), these are temporarily disabled.",
  )

  // 4. Language rule (last, so it is the freshest instruction).
  const lang = args.workingLanguage?.trim() || WORKING_LANGUAGE_FALLBACK
  sections.push(
    "## Language\n" +
      `All internal scaffolding (tool names, this prompt) is English. Reply to the user in ${lang}.`,
  )

  return sections.join("\n\n")
}
