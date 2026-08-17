import { tokenizeText } from "@/lib/search/tokenizer"

export type HealthRibbonStage = "untranslated" | "automatic" | "validated"

export interface HealthRibbonInput {
  id: string
  scope: string
  stage: HealthRibbonStage
  rawScore?: number
  evidenceWeight?: number
}

export interface HealthRibbonPoint {
  id: string
  stage: HealthRibbonStage
  rawScore?: number
  smoothedScore?: number
  topScore?: number
  bottomScore?: number
  topOpacity?: number
  bottomOpacity?: number
  evidenceWeight: number
}

interface WeightedObservation {
  numerator: number
  denominator: number
}

// A fairly broad local kernel keeps row-to-row color changes calm while still
// letting chapter, stage, and missing-evidence boundaries stop the signal.
const DEFAULT_DECAY = 0.78

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function finiteScore(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampScore(value)
    : undefined
}

function compatible(left: HealthRibbonInput, right: HealthRibbonInput): boolean {
  return left.scope === right.scope
    && left.stage === right.stage
    && finiteScore(left.rawScore) !== undefined
    && finiteScore(right.rawScore) !== undefined
}

export function healthRibbonOpacity(point: {
  stage: HealthRibbonStage
  rawScore?: number
  smoothedScore?: number
  evidenceWeight: number
}): number {
  if (point.stage === "validated") return 1
  if (point.stage === "untranslated") {
    // Source-only support is useful context but is not a quality prediction.
    return 0.12 + (0.18 * point.evidenceWeight)
  }
  if (point.rawScore === undefined || point.smoothedScore === undefined) return 0.18

  // Automatic evidence stays deliberately quiet. Local disagreement makes it
  // quieter still instead of letting a noisy single-cell estimate look certain.
  const disagreement = Math.min(1, Math.abs(point.rawScore - point.smoothedScore) / 35)
  return 0.38 - (0.12 * disagreement)
}

/**
 * Build a direction-neutral local trend from noisy cell-level observations.
 *
 * Forward and backward weighted exponential passes are combined, then the
 * current observation is subtracted once because it appears in both passes.
 * Smoothing deliberately stops at stage, scope, and missing-evidence
 * boundaries. In particular, human-validated 100s cannot lift neighboring
 * automatic estimates.
 */
export function buildHealthRibbon(
  sourceInputs: HealthRibbonInput[],
  decay = DEFAULT_DECAY,
): Map<string, HealthRibbonPoint> {
  const normalizedDecay = Math.max(0, Math.min(0.99, decay))
  const inputs = sourceInputs.map((input) => ({
    ...input,
    rawScore: input.stage === "validated" ? 100 : finiteScore(input.rawScore),
    evidenceWeight: Math.max(0.05, Math.min(1, input.evidenceWeight ?? 1)),
  }))
  const forward: Array<WeightedObservation | undefined> = new Array(inputs.length)
  const backward: Array<WeightedObservation | undefined> = new Array(inputs.length)

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]
    if (input.rawScore === undefined) continue

    const current = {
      numerator: input.rawScore * input.evidenceWeight,
      denominator: input.evidenceWeight,
    }
    const previous = index > 0 && compatible(inputs[index - 1], input)
      ? forward[index - 1]
      : undefined
    forward[index] = previous
      ? {
          numerator: current.numerator + normalizedDecay * previous.numerator,
          denominator: current.denominator + normalizedDecay * previous.denominator,
        }
      : current
  }

  for (let index = inputs.length - 1; index >= 0; index--) {
    const input = inputs[index]
    if (input.rawScore === undefined) continue

    const current = {
      numerator: input.rawScore * input.evidenceWeight,
      denominator: input.evidenceWeight,
    }
    const next = index < inputs.length - 1 && compatible(input, inputs[index + 1])
      ? backward[index + 1]
      : undefined
    backward[index] = next
      ? {
          numerator: current.numerator + normalizedDecay * next.numerator,
          denominator: current.denominator + normalizedDecay * next.denominator,
        }
      : current
  }

  const smoothed = inputs.map((input, index) => {
    if (input.rawScore === undefined) return undefined
    const currentNumerator = input.rawScore * input.evidenceWeight
    const numerator = (forward[index]?.numerator ?? 0)
      + (backward[index]?.numerator ?? 0)
      - currentNumerator
    const denominator = (forward[index]?.denominator ?? 0)
      + (backward[index]?.denominator ?? 0)
      - input.evidenceWeight
    return denominator > 0 ? clampScore(numerator / denominator) : input.rawScore
  })

  const points = inputs.map((input, index): HealthRibbonPoint => ({
    id: input.id,
    stage: input.stage,
    rawScore: input.rawScore,
    smoothedScore: smoothed[index],
    evidenceWeight: input.evidenceWeight,
  }))
  const opacities = points.map(healthRibbonOpacity)

  return new Map(points.map((point, index) => {
    const score = smoothed[index]
    // The displayed line blends across any adjacent scored rows even though
    // the statistical smoother still respects scope and stage boundaries.
    // This removes visual seams without letting a validated 100 inflate an
    // automatic score on either side of the boundary.
    const previousScore = index > 0
      && smoothed[index - 1] !== undefined
      ? smoothed[index - 1]
      : undefined
    const nextScore = index < inputs.length - 1
      && smoothed[index + 1] !== undefined
      ? smoothed[index + 1]
      : undefined
    const opacity = opacities[index]

    return [point.id, {
      ...point,
      topScore: score === undefined
        ? undefined
        : previousScore === undefined ? score : (previousScore + score) / 2,
      bottomScore: score === undefined
        ? undefined
        : nextScore === undefined ? score : (score + nextScore) / 2,
      topOpacity: score === undefined
        ? undefined
        : previousScore === undefined ? opacity : (opacities[index - 1] + opacity) / 2,
      bottomOpacity: score === undefined
        ? undefined
        : nextScore === undefined ? opacity : (opacity + opacities[index + 1]) / 2,
    }]
  }))
}

/**
 * Pre-translation evidence is source-side retrieval coverage only. It says how
 * much supplied precedent is available for the source, not how good an
 * unwritten target will be.
 */
export function preTranslationEvidence(
  sourceText: string,
  examples: Array<{ matchedTokens: string[] }>,
): { score: number; evidenceWeight: number } | null {
  const sourceTokens = new Set(tokenizeText(sourceText))
  if (sourceTokens.size === 0 || examples.length === 0) return null

  let bestCoverage = 0
  for (const example of examples) {
    const matched = new Set(
      example.matchedTokens
        .map((token) => token.toLowerCase())
        .filter((token) => sourceTokens.has(token)),
    )
    bestCoverage = Math.max(bestCoverage, matched.size / sourceTokens.size)
  }

  return {
    score: clampScore(bestCoverage * 100),
    evidenceWeight: Math.min(1, examples.length / 5),
  }
}

type Rgb = readonly [number, number, number]

const RED: Rgb = [239, 68, 68]
const AMBER: Rgb = [245, 158, 11]
const GREEN: Rgb = [34, 197, 94]

function interpolateColor(start: Rgb, end: Rgb, amount: number): Rgb {
  return [
    Math.round(start[0] + (end[0] - start[0]) * amount),
    Math.round(start[1] + (end[1] - start[1]) * amount),
    Math.round(start[2] + (end[2] - start[2]) * amount),
  ]
}

export function healthRibbonColor(score: number, opacity?: number): string {
  const normalized = clampScore(score)
  const [red, green, blue] = normalized <= 50
    ? interpolateColor(RED, AMBER, normalized / 50)
    : interpolateColor(AMBER, GREEN, (normalized - 50) / 50)
  return opacity === undefined
    ? `rgb(${red} ${green} ${blue})`
    : `rgb(${red} ${green} ${blue} / ${Math.max(0, Math.min(1, opacity))})`
}
