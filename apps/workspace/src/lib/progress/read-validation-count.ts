import type { ProjectRecord } from "@/lib/parsers/types"

const MIN = 1
const MAX = 15

function clamp(raw: number | undefined): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return MIN
  if (raw < MIN) return MIN
  if (raw > MAX) return MAX
  return Math.floor(raw)
}

export function readValidationCount(project: Pick<ProjectRecord, "validationCount">): number {
  return clamp(project.validationCount)
}

export function readValidationCountAudio(project: Pick<ProjectRecord, "validationCountAudio">): number {
  return clamp(project.validationCountAudio)
}
