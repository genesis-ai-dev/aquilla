import { ShieldQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PromptAnswer } from "@/lib/tools/permissions"
import type { ToolScope } from "../../../shared/tools/manifest"
import { useScopeLabel } from "./scope-label"

export interface PendingPrompt {
  scope: ToolScope
  declared: boolean
  answer: (a: PromptAnswer) => void
}

/** Inline "<Tool> wants to <scope>" prompt shown above a running tool. */
export function PermissionPrompt({ toolName, prompt }: { toolName: string; prompt: PendingPrompt }) {
  const t = useT()
  const scopeLabel = useScopeLabel()
  return (
    <div
      role="alertdialog"
      aria-label={t("extensions.prompt.message", { extension: toolName, scope: scopeLabel(prompt.scope) })}
      className="flex flex-wrap items-center gap-3 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40"
    >
      <ShieldQuestion className="size-4 shrink-0 text-amber-600" aria-hidden />
      <span className="min-w-0 flex-1">
        {t("extensions.prompt.message", { extension: toolName, scope: scopeLabel(prompt.scope) })}
        {!prompt.declared && <span className="ml-2 text-muted-foreground">{t("extensions.prompt.undeclared")}</span>}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => prompt.answer("deny")}>
          {t("extensions.prompt.deny")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => prompt.answer("once")}>
          {t("extensions.prompt.once")}
        </Button>
        <Button size="sm" onClick={() => prompt.answer("always")}>
          {t("extensions.prompt.always")}
        </Button>
      </div>
    </div>
  )
}
