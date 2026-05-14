import type { HealthConfig } from "@/lib/parsers/types"

export const HEALTH_DEFAULTS: HealthConfig = {
  caps: {
    validationGap: 60,
    ancestryPenalty: 20,
    neighborhoodPenalty: 25,
    rulePenalty: 40,
  },
  rulePenalties: { major: 15, minor: 5 },
  neighborhoodWeights: { idJaccard: 0.5, tfidfTokenOverlap: 0.5 },
  neighborhoodSearchLimit: 5,
}
