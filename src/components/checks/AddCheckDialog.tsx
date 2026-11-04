/**
 * AQU-2342: the ONE way to add a check. The first step names where the check
 * comes from (and so its scope); each choice acts on one click and hands over
 * to the editor that store already has.
 */
import { Building2, FileUp, PenLine, Sparkles, type LucideIcon } from "lucide-react"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

interface Choice {
  id: string
  icon: LucideIcon
  titleKey: MessageKey
  descriptionKey: MessageKey
  onChoose: () => void
}

interface AddCheckDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A pattern check for this project (RuleEditor asks which language lanes). */
  onPattern: () => void
  /** Org maintainers only: a pattern check for every project in the org. */
  onOrgPattern?: () => void
  /** Import checks from a style-guide document. */
  onImport?: () => void
  /** Contributors+: extract style rules from the knowledge documents. */
  onExtract?: () => void
}

export function AddCheckDialog({ open, onOpenChange, onPattern, onOrgPattern, onImport, onExtract }: AddCheckDialogProps) {
  const t = useT()
  const choose = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  const choices: Choice[] = [
    { id: "pattern", icon: PenLine, titleKey: "rules.checks.add.pattern.title", descriptionKey: "rules.checks.add.pattern.description", onChoose: onPattern },
    ...(onImport ? [{ id: "import", icon: FileUp, titleKey: "rules.checks.add.import.title", descriptionKey: "rules.checks.add.import.description", onChoose: onImport } as Choice] : []),
    ...(onExtract ? [{ id: "extract", icon: Sparkles, titleKey: "rules.checks.add.extract.title", descriptionKey: "rules.checks.add.extract.description", onChoose: onExtract } as Choice] : []),
    ...(onOrgPattern ? [{ id: "org", icon: Building2, titleKey: "rules.checks.add.org.title", descriptionKey: "rules.checks.add.org.description", onChoose: onOrgPattern } as Choice] : []),
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("rules.checks.add.title")}</DialogTitle>
          <DialogDescription>{t("rules.checks.add.description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {choices.map(({ id, icon: Icon, titleKey, descriptionKey, onChoose }) => (
            <li key={id}>
              <button
                type="button"
                data-add-check={id}
                onClick={choose(onChoose)}
                className="flex w-full items-start gap-3 rounded-md border p-3 text-start hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(titleKey)}</span>
                  <span className="text-xs text-muted-foreground">{t(descriptionKey)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
