// Step one of the New-project wizard: where the project comes from. The three
// answers are the three ways a project could already be created — the
// self-contained form, the linked-target form, and the LangQuest import — so
// nothing here is new, only asked first and one at a time.

import { FilePlus2, Link2 } from "lucide-react"
import { OptionButton, StepHeading } from "@/components/wizard/OptionButton"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ProjectSource } from "@/lib/langquest/wizard"

export function ProjectSourceStep({ onPick, disabled }: { onPick: (source: ProjectSource) => void; disabled?: boolean }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-4" data-testid="project-source-step">
      <StepHeading title={t("langquest.wizard.sourceTitle")} />
      <div className="flex flex-col gap-2">
        <OptionButton
          icon={<FilePlus2 />}
          title={t("langquest.wizard.sourceScratch")}
          hint={t("langquest.wizard.sourceScratchHint")}
          onClick={() => onPick("scratch")}
          disabled={disabled}
          data-testid="project-source-scratch"
        />
        <OptionButton
          icon={<Link2 />}
          title={t("langquest.wizard.sourceLinked")}
          hint={t("langquest.wizard.sourceLinkedHint")}
          onClick={() => onPick("linked")}
          disabled={disabled}
          data-testid="project-source-linked"
        />
        <OptionButton
          icon={<LangQuestLogo className="size-5" />}
          title={t("langquest.create.entry")}
          hint={t("langquest.create.entryHint")}
          onClick={() => onPick("langquest")}
          disabled={disabled}
          data-testid="project-create-langquest"
        />
      </div>
    </div>
  )
}
