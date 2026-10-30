// AQU-2263: the one line, beside every AI key field and key choice, that says
// which key is in use right now. The reading itself is src/lib/settings/key-in-use.ts.

import { KeyRound } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { CompletionKeyInUse, GeminiKeyInUse } from "@/lib/settings/key-in-use"
import { cn } from "@/lib/utils"

const COMPLETION: Record<CompletionKeyInUse, MessageKey> = {
  platform: "settings.keyInUse.platform",
  "project-key": "settings.keyInUse.projectKey",
  "personal-key": "settings.keyInUse.personalKey",
  preferences: "settings.keyInUse.preferences",
  "preferences-no-key": "settings.keyInUse.preferencesNoKey",
  "no-key-needed": "settings.keyInUse.noKeyNeeded",
  missing: "settings.keyInUse.missing",
}

const GEMINI: Record<GeminiKeyInUse, MessageKey> = {
  "project-key": "settings.keyInUse.projectKey",
  "personal-key": "settings.keyInUse.personalKey",
  "org-unused": "settings.keyInUse.geminiOrgUnused",
  missing: "settings.keyInUse.geminiMissing",
}

type Props =
  | { purpose: "completion"; kind: CompletionKeyInUse; testId?: string; className?: string }
  | { purpose: "gemini"; kind: GeminiKeyInUse; testId?: string; className?: string }

export function KeyInUseLine(props: Props) {
  const t = useT()
  const key = props.purpose === "completion" ? COMPLETION[props.kind] : GEMINI[props.kind]
  const short = props.kind === "missing" || props.kind === "org-unused"
  return (
    <span
      className={cn(
        "mt-1 flex items-start gap-1.5 text-xs font-medium",
        short ? "text-amber-700 dark:text-amber-400" : "text-foreground",
        props.className,
      )}
      data-testid={props.testId ?? "key-in-use"}
      data-kind={props.kind}
    >
      <KeyRound className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{t(key, { name: t("projectSettings.advancedLlm.providerFrontierName") })}</span>
    </span>
  )
}
