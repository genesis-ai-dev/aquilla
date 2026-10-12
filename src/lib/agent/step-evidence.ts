import type {
  ContextualActivityDraft,
  ContextualActivitySceneBrief,
} from "@/lib/contextual/transport"

export interface StepEvidence {
  sceneBrief: ContextualActivitySceneBrief | null
  drafts: ContextualActivityDraft[]
}

/** Join the activity bundle to one span. Drafts carry the span id in their
 *  provenance; scene briefs only carry the label. */
export function evidenceForSpan(
  activity: { sceneBriefs: ContextualActivitySceneBrief[]; drafts: ContextualActivityDraft[] } | null,
  spanId: string | undefined,
  spanLabel: string | undefined,
): StepEvidence {
  if (!activity || (!spanId && !spanLabel)) return { sceneBrief: null, drafts: [] }
  const drafts = activity.drafts.filter((d) =>
    (spanId && d.provenance?.spanId === spanId) || (spanLabel && d.spanLabel === spanLabel),
  )
  const sceneBrief = spanLabel
    ? activity.sceneBriefs.find((b) => b.spanLabel === spanLabel) ?? null
    : null
  return { sceneBrief, drafts }
}
