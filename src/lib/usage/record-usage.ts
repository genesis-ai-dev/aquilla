import type { ProjectRecord, ProjectUsage } from "@/lib/parsers/types"

interface LlmCallMeta {
  kind: string
  model?: string
  provider: string
}

function emptyUsage(): ProjectUsage {
  return { llmCalls: {}, fixesApplied: 0 }
}

export function addLlmCall(project: ProjectRecord, meta: LlmCallMeta): ProjectRecord {
  const usage: ProjectUsage = project.usage ? cloneUsage(project.usage) : emptyUsage()
  const key = meta.kind
  const bucket = usage.llmCalls[key] || { total: 0, byModel: {}, byProvider: {} }
  const modelKey = meta.model?.trim() || "(default)"
  bucket.total += 1
  bucket.byModel[modelKey] = (bucket.byModel[modelKey] || 0) + 1
  bucket.byProvider[meta.provider] = (bucket.byProvider[meta.provider] || 0) + 1
  usage.llmCalls[key] = bucket
  return { ...project, usage }
}

export function addFixApplied(project: ProjectRecord): ProjectRecord {
  const usage: ProjectUsage = project.usage ? cloneUsage(project.usage) : emptyUsage()
  usage.fixesApplied += 1
  return { ...project, usage }
}

function cloneUsage(u: ProjectUsage): ProjectUsage {
  const llmCalls: ProjectUsage["llmCalls"] = {}
  for (const [k, v] of Object.entries(u.llmCalls)) {
    llmCalls[k] = { total: v.total, byModel: { ...v.byModel }, byProvider: { ...v.byProvider } }
  }
  return { llmCalls, fixesApplied: u.fixesApplied }
}
