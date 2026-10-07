// Project-wide terminology scans (AQU-1192). The browser receives violations,
// candidate terms, or suggested renderings — not every verse.

import type { PredictedEquivalent } from "@/lib/terminology/equivalents"
import {
  parsePredictedEquivalents,
  parseTerminologyCandidatesPage,
  parseTerminologyViolationsPage,
  type TerminologyCandidatesPage,
  type TerminologyViolationsPage,
} from "@/lib/terminology/project-scan"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

export class TerminologyScanError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`terminology scan failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "TerminologyScanError"
  }
}

async function getJson(url: string, jwt: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new TerminologyScanError(res.status, body)
  }
  return res.json()
}

export async function fetchTerminologyViolations(
  projectId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<TerminologyViolationsPage> {
  const body = await getJson(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/terminology/violations`,
    jwt,
    signal,
  )
  const page = parseTerminologyViolationsPage(body)
  if (!page) throw new TerminologyScanError(200, "unexpected violations payload")
  return page
}

export async function fetchTerminologyCandidates(
  projectId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<TerminologyCandidatesPage> {
  const body = await getJson(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/terminology/candidates`,
    jwt,
    signal,
  )
  const page = parseTerminologyCandidatesPage(body)
  if (!page) throw new TerminologyScanError(200, "unexpected candidates payload")
  return page
}

export async function fetchConceptSuggestions(
  projectId: string,
  conceptId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<PredictedEquivalent[]> {
  const body = await getJson(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/concepts/${encodeURIComponent(conceptId)}/suggestions`,
    jwt,
    signal,
  )
  const suggestions = parsePredictedEquivalents(body)
  if (!suggestions) throw new TerminologyScanError(200, "unexpected suggestions payload")
  return suggestions
}
