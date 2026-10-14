import { Globe, ShieldQuestion } from "lucide-react"
import { ExtensionMarker } from "@/components/tools/ExtensionMarker"
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
export function PermissionPrompt({ toolName, prompt, web }: { toolName: string; prompt: PendingPrompt; web?: readonly string[] }) {
  const t = useT()
  const scopeLabel = useScopeLabel()
  // read:web names the sites, says the site sees the request, and has no "Allow once":
  // the server proxy only serves a standing grant.
  const isWeb = prompt.scope === "read:web"
  const message = isWeb && web?.length
    ? t("extensions.prompt.web", { extension: toolName, domains: web.join(", ") })
    : t("extensions.prompt.message", { extension: toolName, scope: scopeLabel(prompt.scope) })
  return (
    <div
      role="alertdialog"
      aria-label={message}
      className="solid-primary flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-primary/5 px-4 py-3 text-sm transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        {isWeb ? <Globe className="size-4" aria-hidden /> : <ShieldQuestion className="size-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <ExtensionMarker className="mb-0.5" />
        <span className="block font-medium">{message}</span>
        <span className="block text-xs text-muted-foreground">
          {isWeb ? t("extensions.perm.webNote") : t("extensions.prompt.note")}
          {!prompt.declared && <span className="ms-1">{t("extensions.prompt.undeclared")}</span>}
        </span>
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => prompt.answer("deny")}>
          {t("extensions.prompt.deny")}
        </Button>
        {!isWeb && (
          <Button size="sm" variant="outline" onClick={() => prompt.answer("once")}>
            {t("extensions.prompt.once")}
          </Button>
        )}
        <Button size="sm" onClick={() => prompt.answer("always")}>
          {t("extensions.prompt.always")}
        </Button>
      </div>
    </div>
  )
}
