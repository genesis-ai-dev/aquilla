import { useEffect, useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useRules } from "@/hooks/useRules"
import { useFeatureFlag } from "@/hooks/useFeatureFlag"
import { useLiveness } from "@/hooks/useLiveness"
import {
  collectRecentExampleCandidates,
  type RecentExampleCandidate,
} from "@/lib/store/file-doc"
import {
  selectRecentValidatedExamples,
  type RecentExample,
} from "@/components/living-memory/recent-examples"
import { LivenessIndicator } from "@/components/living-memory/LivenessIndicator"
import { InstructionsSection } from "@/components/living-memory/InstructionsSection"
import { StandardsSection } from "@/components/living-memory/StandardsSection"
import { RecentExamplesSection } from "@/components/living-memory/RecentExamplesSection"

const RECENT_EXAMPLES_LIMIT = 10

export function LivingMemoryPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(id!)
  // useRules takes (project, refresh) and returns an object whose `rules`
  // field is the current array. See src/hooks/useRules.ts.
  const { rules } = useRules(project, refresh)
  const enabled = useFeatureFlag("living-memory-view", project)

  // Bump counter advances whenever upstream state identity changes —
  // drives the "updating" flash on the liveness indicator.
  // useLiveness requires a counter that increments on each upstream change;
  // this effect pattern is intentional and the only compliant way to feed
  // an external hook that doesn't accept reactive deps directly.
  const [bumpedAt, setBumpedAt] = useState(0)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setBumpedAt((n) => n + 1) }, [project, rules])

  const { state, label } = useLiveness(bumpedAt)

  // Aggregate validated examples across every file in the project. One-shot
  // load on mount + whenever the project's file list changes; not reactive
  // to per-cell edits (acceptable for v1 — the liveness flash still signals
  // that something changed, even if the list needs a refresh to catch up).
  const [candidates, setCandidates] = useState<RecentExampleCandidate[]>([])
  useEffect(() => {
    if (!project) return
    let cancelled = false
    const fileIds = project.files.map((f) => f.id)
    collectRecentExampleCandidates(fileIds).then((result) => {
      if (!cancelled) setCandidates(result)
    })
    return () => {
      cancelled = true
    }
  }, [project])

  const examples: RecentExample[] = useMemo(
    () => selectRecentValidatedExamples(candidates, RECENT_EXAMPLES_LIMIT),
    [candidates],
  )

  // Flag-off redirect — after project has loaded, not during.
  useEffect(() => {
    if (!loading && !enabled && project) {
      navigate(`/project/${id}`, {
        replace: true,
        state: {
          toast:
            "Living Memory is an experimental feature. Enable it in Project Settings.",
        },
      })
    }
  }, [loading, enabled, project, id, navigate])

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  }
  if (!project || !enabled) {
    return null
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Living Memory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This is what Codex has learned about your project. It grows with
            every edit, correction, and validation you make.
          </p>
        </div>
        <LivenessIndicator state={state} label={label} />
      </header>

      <InstructionsSection
        projectId={project.id}
        systemPrompt={project.completionSettings?.systemPrompt}
        sourceLanguage={project.sourceLanguage}
        targetLanguage={project.targetLanguage}
      />
      <StandardsSection projectId={project.id} rules={rules} />
      <RecentExamplesSection examples={examples} />
    </div>
  )
}
