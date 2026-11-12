// Client for POST /api/v1/ai/passage-tags/classify (AQU-657, slice 1).
//
// Thin on purpose, exactly like ../completion/seam-classify-client.ts: the route
// already answers 200-with-heuristics on every degraded path, so there is almost
// nothing for this layer to recover from. What it adds is the last backstop — a
// network error or a malformed body resolves to an empty result rather than
// rejecting, because the caller is a background pass and every reader of the
// tree is already correct with no tags at all.

import { AUTH_BASE } from "@/lib/frontier/auth"
import { isPassageTags, type PassageTags } from "./passage-tags"
import type { TaggedNodeRequest } from "./passage-tag-request"

export const PASSAGE_TAGS_CLASSIFY_URL = `${AUTH_BASE}/api/v1/ai/passage-tags/classify`

export interface PassageTagClassifyOptions {
  identityToken: string
  projectId: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Tag one window of passage nodes. Returns [] on any failure — never throws, so
 * a background tagging pass cannot surface an error to a translator who did not
 * ask for one.
 */
export async function classifyPassageTagWindow(
  window: readonly TaggedNodeRequest[],
  options: PassageTagClassifyOptions,
): Promise<PassageTags[]> {
  if (window.length === 0) return []
  try {
    const response = await (options.fetchImpl ?? fetch)(PASSAGE_TAGS_CLASSIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.identityToken}`,
      },
      body: JSON.stringify({
        projectId: options.projectId,
        nodes: window.map(({ node, candidates }) => ({
          key: node.key,
          label: node.label,
          text: node.text,
          startRef: node.startRef ?? null,
          endRef: node.endRef ?? null,
          participants: [...candidates.participants],
          related: candidates.related.map((candidate) => ({
            key: candidate.key,
            label: candidate.label,
            text: candidate.text,
          })),
        })),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return []
    const body = await response.json() as { tags?: unknown }
    if (!Array.isArray(body.tags)) return []
    return body.tags.filter(isPassageTags)
  } catch {
    return []
  }
}
