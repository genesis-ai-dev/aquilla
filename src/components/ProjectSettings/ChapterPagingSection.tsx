import type { ReactNode } from "react"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type {
  ChapterCompletionAction,
  ChapterCompletionTrigger,
} from "@/lib/parsers/types"

export interface ChapterPagingFormValue {
  chapterPagingEnabled: boolean
  chapterCompletionTrigger: ChapterCompletionTrigger
  chapterCompletionAction: ChapterCompletionAction
}

interface Props {
  value: ChapterPagingFormValue
  onChange: (next: Partial<ChapterPagingFormValue>) => void
  disabled?: boolean
  disabledTooltip?: ReactNode
}

const TRIGGERS: {
  value: ChapterCompletionTrigger
  labelKey: MessageKey
  descriptionKey: MessageKey
}[] = [
  {
    value: "allTranslated",
    labelKey: "projectSettings.editor.triggerTranslatedLabel",
    descriptionKey: "projectSettings.editor.triggerTranslatedDescription",
  },
  {
    value: "allValidated",
    labelKey: "projectSettings.editor.triggerValidatedLabel",
    descriptionKey: "projectSettings.editor.triggerValidatedDescription",
  },
  {
    value: "manual",
    labelKey: "projectSettings.editor.triggerManualLabel",
    descriptionKey: "projectSettings.editor.triggerManualDescription",
  },
]

const ACTIONS: {
  value: ChapterCompletionAction
  labelKey: MessageKey
  descriptionKey: MessageKey
}[] = [
  {
    value: "prompt",
    labelKey: "projectSettings.editor.actionPromptLabel",
    descriptionKey: "projectSettings.editor.actionPromptDescription",
  },
  {
    value: "autoAdvance",
    labelKey: "projectSettings.editor.actionAutoLabel",
    descriptionKey: "projectSettings.editor.actionAutoDescription",
  },
  {
    value: "stay",
    labelKey: "projectSettings.editor.actionStayLabel",
    descriptionKey: "projectSettings.editor.actionStayDescription",
  },
]

function RadioOption({
  value,
  label,
  description,
  disabled,
}: {
  value: string
  label: string
  description: string
  disabled: boolean
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <RadioGroupItem value={value} className="mt-1" disabled={disabled} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  )
}

export function ChapterPagingSection({
  value,
  onChange,
  disabled = false,
  disabledTooltip,
}: Props) {
  const t = useT()
  const pagingOn = value.chapterPagingEnabled
  const showAction = pagingOn && value.chapterCompletionTrigger !== "manual"

  return (
    <div id="section-editor">
      <SettingsGroup label={t("projectSettings.section.editor")}>
        <SettingsRow
          label={
            <label htmlFor="chapter-paging-enabled">
              {t("projectSettings.editor.pagingLabel")}
            </label>
          }
          description={t("projectSettings.editor.pagingDescription")}
          control={
            <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
              <Switch
                id="chapter-paging-enabled"
                data-testid="settings-chapter-paging"
                checked={pagingOn}
                onCheckedChange={(checked) => onChange({ chapterPagingEnabled: checked })}
                disabled={disabled}
                aria-label={t("projectSettings.editor.pagingLabel")}
              />
            </DisabledFieldTooltip>
          }
        />
        {pagingOn ? (
          <SettingsRow
            label={t("projectSettings.editor.triggerLabel")}
            description={t("projectSettings.editor.triggerDescription")}
            block
          >
            <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
              <RadioGroup
                name="chapter-completion-trigger"
                data-testid="settings-chapter-completion-trigger"
                value={value.chapterCompletionTrigger}
                onValueChange={(next) => {
                  if (next === "allTranslated" || next === "allValidated" || next === "manual") {
                    onChange({ chapterCompletionTrigger: next })
                  }
                }}
                className="flex flex-col gap-2"
                aria-label={t("projectSettings.editor.triggerLabel")}
              >
                {TRIGGERS.map((option) => (
                  <RadioOption
                    key={option.value}
                    value={option.value}
                    label={t(option.labelKey)}
                    description={t(option.descriptionKey)}
                    disabled={disabled}
                  />
                ))}
              </RadioGroup>
            </DisabledFieldTooltip>
          </SettingsRow>
        ) : null}
        {showAction ? (
          <SettingsRow
            label={t("projectSettings.editor.actionLabel")}
            description={t("projectSettings.editor.actionDescription")}
            block
          >
            <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
              <RadioGroup
                name="chapter-completion-action"
                data-testid="settings-chapter-completion-action"
                value={value.chapterCompletionAction}
                onValueChange={(next) => {
                  if (next === "prompt" || next === "autoAdvance" || next === "stay") {
                    onChange({ chapterCompletionAction: next })
                  }
                }}
                className="flex flex-col gap-2"
                aria-label={t("projectSettings.editor.actionLabel")}
              >
                {ACTIONS.map((option) => (
                  <RadioOption
                    key={option.value}
                    value={option.value}
                    label={t(option.labelKey)}
                    description={t(option.descriptionKey)}
                    disabled={disabled}
                  />
                ))}
              </RadioGroup>
            </DisabledFieldTooltip>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </div>
  )
}
