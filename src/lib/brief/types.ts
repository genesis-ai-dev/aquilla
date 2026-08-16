import type { MessageKey } from "@/lib/i18n/messages/en"

export type BriefGroup = "purpose" | "standards"
export type BriefStatus = "none" | "draft" | "complete"

export interface BriefField {
  id: string
  /** i18n key for the interview-step/field label — resolve with `t()` at
   *  render time (BriefBuilder) or `t()` from standalone at call time
   *  (brief.ts, brief-generator.ts). Never call `t()` at module scope. */
  labelKey: MessageKey
  group: BriefGroup
  /** i18n key for the field's helper text, same resolution rule as labelKey. */
  helperTextKey: MessageKey
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
