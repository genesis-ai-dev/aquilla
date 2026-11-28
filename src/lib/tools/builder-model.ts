/**
 * Smart Extensions builder — the pure rules behind the guided flow
 * (Describe → Review & try → Add to project). No React, no I/O, so each rule
 * is unit-tested on its own.
 */

import type { ToolManifest, ToolMount, ToolScope } from "../../../shared/tools/manifest"
import type { extensions } from "../i18n/namespaces/extensions"
import type { BuildPhase } from "./build-flow"

type ExtensionKey = keyof typeof extensions.keys

/** The three steps a first-time user goes through. */
export type BuilderStep = "describe" | "review" | "add"

/** Where the user wants the extension to show up ("auto" = let the AI choose). */
export type WhereChoice =
  | "auto"
  | "panel"
  | "column"
  | "inline"
  | "importer"
  | "exporter"
  | "page"
  | "editor"

export const WHERE_CHOICES: readonly WhereChoice[] = [
  "auto",
  "panel",
  "column",
  "inline",
  "importer",
  "exporter",
  "page",
  "editor",
]

/** Read a `?where=` preset (contextual "+ Build a…" links across the app). */
export function parseWhere(value: string | null | undefined): WhereChoice {
  return WHERE_CHOICES.find((w) => w === value) ?? "auto"
}

/** Build the deep link to the Smart Extensions builder with optional placement + open file context. */
export function buildExtensionPath(
  projectId: string,
  opts: { where?: WhereChoice; fileId?: string | null } = {},
): string {
  const qs = new URLSearchParams()
  if (opts.where && opts.where !== "auto") qs.set("where", opts.where)
  if (opts.fileId) qs.set("fileId", opts.fileId)
  const query = qs.toString()
  return `/project/${projectId}/extensions${query ? `?${query}` : ""}`
}

/**
 * The request the builder model receives: the user's words, plus one plain
 * sentence for a chosen placement. The builder prompt is English, so the
 * appended sentence is too (it is never shown to the user).
 */
export function composeRequest(text: string, where: WhereChoice): string {
  const words = text.trim()
  if (!words || where === "auto") return words
  const sentenceByWhere: Record<Exclude<WhereChoice, "auto">, string> = {
    panel: "It should appear in the editor's side panel (mount: panel).",
    column:
      "It should integrate into Aquilla's native editor using a read-only column (manifest.columns) and/or native row badges, wavy span highlights, and quick-fixes via aq.editor.annotate(), with a toolbar action (where: ['bar']) to run it.",
    inline: "It should appear inline under each verse in the cell details Extensions tab (mount: inline, reading aquilla.context.cell).",
    importer:
      "It should be an importer contribution in Aquilla's Import dialog (manifest.importers with schema-driven options, scope write:files, creating/updating files via aquilla.files.upsert).",
    exporter:
      "It should be a custom export format in Aquilla's Export dialog (manifest.exports, delivering files via aquilla.export.deliver).",
    page: "It should be its own page (mount: page).",
    editor: "It should replace the editor for a file, as a full editing surface (mount: editor).",
  }
  return `${words}\n\n${sentenceByWhere[where]}`
}

export interface ExamplePrompt {
  title: ExtensionKey
  prompt: ExtensionKey
  where: WhereChoice
}

/** Default suggestions when placement is "auto". */
export const EXAMPLE_PROMPTS = [
  { title: "extensions.examples.graceAcrossBooksTitle", prompt: "extensions.examples.graceAcrossBooks", where: "auto" },
  { title: "extensions.examples.wordCountTitle", prompt: "extensions.examples.wordCount", where: "panel" },
  { title: "extensions.examples.untranslatedTitle", prompt: "extensions.examples.untranslated", where: "auto" },
  { title: "extensions.examples.focusEditorTitle", prompt: "extensions.examples.focusEditor", where: "editor" },
] as const satisfies readonly ExamplePrompt[]

/** Contextual composer placeholder key per placement. */
export const WHERE_PLACEHOLDERS: Record<WhereChoice, ExtensionKey> = {
  auto: "extensions.describe.placeholder",
  panel: "extensions.describe.placeholderPanel",
  column: "extensions.describe.placeholderColumn",
  inline: "extensions.describe.placeholderInline",
  importer: "extensions.describe.placeholderImporter",
  exporter: "extensions.describe.placeholderExporter",
  page: "extensions.describe.placeholderPage",
  editor: "extensions.describe.placeholderEditor",
}

const EXAMPLES_BY_WHERE: Record<Exclude<WhereChoice, "auto">, readonly ExamplePrompt[]> = {
  panel: [
    { title: "extensions.examples.activeVerseNotesTitle", prompt: "extensions.examples.activeVerseNotes", where: "panel" },
    { title: "extensions.examples.wordCountTitle", prompt: "extensions.examples.wordCount", where: "panel" },
    { title: "extensions.examples.graceAcrossBooksTitle", prompt: "extensions.examples.graceAcrossBooks", where: "panel" },
  ],
  column: [
    { title: "extensions.examples.studyNotesColTitle", prompt: "extensions.examples.studyNotesCol", where: "column" },
    { title: "extensions.examples.lengthRatioColTitle", prompt: "extensions.examples.lengthRatioCol", where: "column" },
    { title: "extensions.examples.punctuationCheckTitle", prompt: "extensions.examples.punctuationCheck", where: "column" },
  ],
  inline: [
    { title: "extensions.examples.inlineGlossaryTitle", prompt: "extensions.examples.inlineGlossary", where: "inline" },
    { title: "extensions.examples.inlineChecklistTitle", prompt: "extensions.examples.inlineChecklist", where: "inline" },
  ],
  importer: [
    { title: "extensions.examples.glossaryImporterTitle", prompt: "extensions.examples.glossaryImporter", where: "importer" },
    { title: "extensions.examples.notesImporterTitle", prompt: "extensions.examples.notesImporter", where: "importer" },
  ],
  exporter: [
    { title: "extensions.examples.annotatedTsvExporterTitle", prompt: "extensions.examples.annotatedTsvExporter", where: "exporter" },
    { title: "extensions.examples.reviewDocExporterTitle", prompt: "extensions.examples.reviewDocExporter", where: "exporter" },
  ],
  page: [
    { title: "extensions.examples.chapterProgressPageTitle", prompt: "extensions.examples.chapterProgressPage", where: "page" },
    { title: "extensions.examples.graceAcrossBooksTitle", prompt: "extensions.examples.graceAcrossBooks", where: "page" },
    { title: "extensions.examples.untranslatedTitle", prompt: "extensions.examples.untranslated", where: "page" },
  ],
  editor: [
    { title: "extensions.examples.focusEditorTitle", prompt: "extensions.examples.focusEditor", where: "editor" },
    { title: "extensions.examples.interlinearEditorTitle", prompt: "extensions.examples.interlinearEditor", where: "editor" },
  ],
}

/** Suggestions tailored to the chosen placement ("auto" keeps the general set). */
export function examplesForWhere(where: WhereChoice): readonly ExamplePrompt[] {
  return where === "auto" ? EXAMPLE_PROMPTS : EXAMPLES_BY_WHERE[where]
}

/** Where to take the user right after "Add to project" succeeds. */
export function postInstallTarget(
  projectId: string,
  toolId: string,
  manifest: Pick<ToolManifest, "mounts" | "columns" | "importers" | "exports">,
  opts: { where?: WhereChoice; fileId?: string | null } = {},
): string {
  const filePath = opts.fileId ? `/project/${projectId}/editor/file/${opts.fileId}` : `/project/${projectId}/editor`
  if (manifest.mounts.includes("editor")) return filePath
  const wantsEditor =
    opts.where === "panel"
    || opts.where === "column"
    || opts.where === "inline"
    || opts.where === "importer"
    || opts.where === "exporter"
    || (Boolean(opts.fileId) && (
      manifest.mounts.includes("panel")
      || manifest.mounts.includes("inline")
      || (manifest.columns?.length ?? 0) > 0
      || (manifest.importers?.length ?? 0) > 0
      || (manifest.exports?.length ?? 0) > 0
    ))
  return wantsEditor ? filePath : `/project/${projectId}/extensions/${toolId}`
}

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
