/**
 * FileCandidateButtons.tsx (AQU-1468) — the agent asked "which file?", so show
 * each candidate file as a button labelled with its exact name.
 *
 * The buttons are live only on the newest run while nothing is streaming.
 * After that they stay visible but disabled, so an old question can never
 * point a later run at a file.
 */

import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import type { FileCandidate } from "@/lib/agent/protocol"

export function FileCandidateButtons({
  candidates,
  enabled,
  onChoose,
}: {
  candidates: FileCandidate[]
  enabled: boolean
  onChoose: (candidate: FileCandidate) => void
}) {
  const t = useT()
  if (candidates.length === 0) return null
  return (
    <div role="group" aria-label={t("agent.run.chooseFile")} className="flex flex-col gap-1.5">
      <div className="text-[11px] text-muted-foreground">{t("agent.run.chooseFile")}</div>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((candidate) => (
          <Button
            key={candidate.id}
            type="button"
            variant="outline"
            size="xs"
            disabled={!enabled}
            onClick={() => {
              if (enabled) onChoose(candidate)
            }}
          >
            {candidate.name}
          </Button>
        ))}
      </div>
    </div>
  )
}
