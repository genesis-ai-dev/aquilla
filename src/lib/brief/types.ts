export type BriefGroup = "purpose" | "standards"
export type BriefStatus = "none" | "draft" | "complete"

export interface BriefField {
  id: string
  label: string
  group: BriefGroup
  helperText: string
}

export interface TranslationBrief {
  version: number
  updatedAt: string
  updatedBy: string
  parameters: Record<string, string>
  freeformNotes: string
  l2Markdown: string
  l1Summary: string | null
  l1GeneratedAt: string | null
  l1ModelId: string | null
}
