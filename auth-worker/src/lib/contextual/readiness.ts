// Context readiness — "does autopilot know enough to do professional work
// here?", answered BEFORE someone spends a run finding out.
//
// The failure this prevents is specific and expensive. Autopilot always
// produces output. With no brief, no terminology and no validated examples it
// produces *fluent, confident, generic* output — the most costly kind, because
// nothing about it looks wrong until a consultant reads it. The run reports
// spans staged either way, so the product's own progress numbers actively hide
// the problem.
//
// So readiness is not a gate (nobody is blocked from pressing play) and not a
// score to optimise. It is a checklist that names what a professional
// translator would have on the desk, says which of those things this project
// has, and links the rest.

import type { ProjectContext } from "./project-context"

export type ReadinessLevel = "ready" | "partial" | "missing"

export interface ReadinessItem {
  id: string
  /** Plain user words — this renders in the product, not in a log. */
  label: string
  level: ReadinessLevel
  /** What this changes about the output, stated concretely. */
  detail: string
  /** Where to go and fix it, relative to the project. */
  href?: string
}

export interface ContextReadiness {
  items: ReadinessItem[]
  /** Items a translator would consider non-negotiable that are missing. */
  blockingGaps: number
  /** True when nothing important is missing. */
  ready: boolean
}

/** Validated pairs below this and the performer is imitating almost nothing —
 *  the same threshold the risk router uses for example coverage. */
const MIN_EXAMPLES = 8
/** A brief with fewer answered fields than this is a stub, not a brief. */
const MIN_BRIEF_FIELDS = 4

export interface ReadinessInput {
  context: ProjectContext
  /** Validated source/target pairs available as few-shot examples. */
  validatedExamples: number
  /** Untranslated cells the run would work on. */
  untranslatedCells: number
}

/**
 * Score the project's context. Ordered by how much each item changes the
 * WORDING of a draft — terminology first, because a key term rendered
 * inconsistently is the defect a consultant will reject a book over.
 */
export function computeContextReadiness(input: ReadinessInput): ContextReadiness {
  const { context, validatedExamples } = input
  const items: ReadinessItem[] = []

  // ── Key terms ──
  const conceptsWithDecisions = context.concepts.filter((c) =>
    c.renderings.some((r) => r.status === "preferred" || r.status === "admitted"),
  ).length
  items.push({
    id: "terminology",
    label: "Key terms",
    level: conceptsWithDecisions === 0 ? "missing" : conceptsWithDecisions < 10 ? "partial" : "ready",
    detail:
      conceptsWithDecisions === 0
        ? "No key terms have an approved rendering yet. Autopilot will translate them ad hoc, and each passage may word them differently."
        : `${conceptsWithDecisions} key ${conceptsWithDecisions === 1 ? "term has" : "terms have"} an approved rendering. Autopilot is told the ones that appear in each passage and must use them.`,
    href: "terminology",
  })

  // ── Translation brief ──
  const answered = Object.values(context.briefParameters).filter((v) => v && v.trim()).length
  const hasL1 = Boolean(context.projectBriefL1)
  items.push({
    id: "brief",
    label: "Translation brief",
    level: answered === 0 && !hasL1 ? "missing" : answered < MIN_BRIEF_FIELDS ? "partial" : "ready",
    detail:
      answered === 0 && !hasL1
        ? "No brief. Autopilot has to guess your audience, register, and how literal to be — the decisions that shape every sentence."
        : `${answered} of the brief's questions answered${hasL1 ? ", summarised for every passage" : ""}. Audience, register, and literalness ride in each draft prompt.`,
        // The brief builder lives on Living Memory in project settings.
        href: "settings/memory",
  })

  // ── Examples of your team's own work ──
  items.push({
    id: "examples",
    label: "Approved examples",
    level:
      validatedExamples === 0 ? "missing" : validatedExamples < MIN_EXAMPLES ? "partial" : "ready",
    detail:
      validatedExamples === 0
        ? "No validated translations yet. Autopilot has no sample of your team's voice to imitate — validate a few translations first and the drafts will sound far more like you."
        : `${validatedExamples} validated ${validatedExamples === 1 ? "translation" : "translations"} to imitate. This is where the drafts learn your team's voice.`,
  })

  // ── Project rules ──
  const authored = context.authoredRules.length
  items.push({
    id: "rules",
    label: "Project checks",
    level: authored === 0 ? "partial" : "ready",
    detail:
      authored === 0
        ? "No hand-written checks. Key-term checks still run; add rules for punctuation, spelling, or formatting conventions you care about."
        : `${authored} ${authored === 1 ? "check runs" : "checks run"} on every draft before it reaches you.`,
    href: "settings/rules",
  })

  // ── Languages ──
  const hasLanguages = Boolean(context.sourceLanguage && context.targetLanguage)
  items.push({
    id: "languages",
    label: "Languages",
    level: hasLanguages ? "ready" : "partial",
    detail: hasLanguages
      ? `Translating ${context.sourceLanguage} → ${context.targetLanguage}.`
      : "Source or target language isn't set, so autopilot has to infer it from your existing translations.",
    href: "settings",
  })

  // Only terminology, the brief, and examples change the WORDING enough that a
  // translator would call a run premature without them.
  const blockingGaps = items.filter(
    (i) => i.level === "missing" && ["terminology", "brief", "examples"].includes(i.id),
  ).length

  return { items, blockingGaps, ready: blockingGaps === 0 }
}
