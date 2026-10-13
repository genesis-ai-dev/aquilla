/**
 * Smart Extensions builder — the pure rules behind the guided flow
 * (Describe → Review & try → Add to project). No React, no I/O, so each rule
 * is unit-tested on its own.
 */

import type { ToolMount, ToolScope } from "../../../shared/tools/manifest"
import type { BuildPhase } from "./build-flow"

/** The three steps a first-time user goes through. */
export type BuilderStep = "describe" | "review" | "add"

/** Where the user wants the extension to show up ("auto" = let the AI choose). */
export type WhereChoice = "auto" | "panel" | "page" | "editor"

export const WHERE_CHOICES: readonly WhereChoice[] = ["auto", "panel", "page", "editor"]

/** Read a `?where=` preset (the editor's "Build your own editor…" link). */
export function parseWhere(value: string | null | undefined): WhereChoice {
  return value === "panel" || value === "page" || value === "editor" ? value : "auto"
}

/**
 * The request the builder model receives: the user's words, plus one plain
 * sentence for a chosen placement. The builder prompt is English, so the
 * appended sentence is too (it is never shown to the user).
 */
export function composeRequest(text: string, where: WhereChoice): string {
  const words = text.trim()
  if (!words || where === "auto") return words
  const sentence = where === "panel"
    ? "It should appear in the editor's side panel (mount: panel)."
    : where === "editor"
      ? "It should replace the editor for a file, as a full editing surface (mount: editor)."
      : "It should be its own page (mount: page)."
  return `${words}\n\n${sentence}`
}

/** Suggestions (i18n keys): a short title on the pill; the full prompt fills the composer. */
export const EXAMPLE_PROMPTS = [
  { title: "extensions.examples.graceAcrossBooksTitle", prompt: "extensions.examples.graceAcrossBooks", where: "auto" },
  { title: "extensions.examples.wordCountTitle", prompt: "extensions.examples.wordCount", where: "panel" },
  { title: "extensions.examples.untranslatedTitle", prompt: "extensions.examples.untranslated", where: "auto" },
  { title: "extensions.examples.focusEditorTitle", prompt: "extensions.examples.focusEditor", where: "editor" },
] as const satisfies readonly { title: string; prompt: string; where: WhereChoice }[]

export type ProgressStepId = "write" | "check" | "try" | "fix"
export type ProgressState = "pending" | "active" | "done"
export interface ProgressStep {
  id: ProgressStepId
  state: ProgressState
}

/**
 * The build's real phases as a step list: write the code, the safety check
 * (lint), try it in a sandbox (smoke render). "Fix" appears only once a check
 * failed and the model is repairing its own attempt.
 */
export function progressSteps(phase: BuildPhase | null): ProgressStep[] {
  const kind = phase?.kind ?? "generating"
  const repairing = kind === "repairing" || (phase !== null && "attempt" in phase && phase.attempt > 0)
  const order: ProgressStepId[] = repairing ? ["write", "fix", "check", "try"] : ["write", "check", "try"]
  const current: ProgressStepId | "done" =
    kind === "done" ? "done"
      : kind === "repairing" ? "fix"
        : kind === "linting" ? "check"
          : kind === "smoke" ? "try"
            : kind === "failed" ? "try"
              : repairing ? "fix" : "write"
  const at = current === "done" ? order.length : order.indexOf(current)
  return order.map((id, i) => ({ id, state: i < at ? "done" : i === at ? "active" : "pending" }))
}

/** "1:05" from milliseconds (the elapsed timer while building). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** What an extension may do, grouped for people: what it reads, what it
 *  changes (asks first), and whether it uses the project's AI credits. */
export function groupScopes(scopes: readonly ToolScope[]): { reads: ToolScope[]; changes: ToolScope[]; ai: ToolScope[] } {
  const reads: ToolScope[] = []
  const changes: ToolScope[] = []
  const ai: ToolScope[] = []
  for (const s of scopes) {
    if (s.startsWith("read:")) reads.push(s)
    else if (s.startsWith("ai:")) ai.push(s)
    else changes.push(s)
  }
  return { reads, changes, ai }
}

/** The one place to say an extension lives (an editor replacement first). */
export function primaryMount(mounts: readonly ToolMount[]): ToolMount {
  if (mounts.includes("editor")) return "editor"
  if (mounts.includes("panel")) return "panel"
  if (mounts.includes("inline")) return "inline"
  return "page"
}

/** Who made it, for the installed list. */
export type ToolProvenance = "firstParty" | "builder" | "starter" | "copy" | "edited"

export function provenanceOf(tool: { firstParty?: string | null; upstreamToolId: string | null; origin: string }): ToolProvenance {
  if (tool.firstParty) return "firstParty"
  if (tool.upstreamToolId) return "copy"
  if (tool.origin === "starter") return "starter"
  if (tool.origin === "edit") return "edited"
  return "builder"
}

/** Which step the stepper highlights for the page's state: describing is
 *  done once a build starts — the build is preparing Review & try. */
export function stepFor(state: { building: boolean; hasCandidate: boolean }): BuilderStep {
  if (state.hasCandidate || state.building) return "review"
  return "describe"
}

/** "edit translations, read the termbase" → "Edit translations, read the termbase". */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text
}

/** A short list for one line: the first `max` items, then "+N". */
export function shortList(items: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) }
}

/** The words a version was made from, if a person described it. */
export function versionRequest(v: { buildMeta: Record<string, unknown> | null }): string | null {
  const r = v.buildMeta?.request
  return typeof r === "string" && r.trim() ? r.trim() : null
}
