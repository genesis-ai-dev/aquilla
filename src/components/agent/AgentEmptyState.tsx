/**
 * AgentEmptyState.tsx — first-run guide shown in the agent chat before any
 * runs exist. Example prompts prefill the composer (never auto-send, so no
 * surprise credit spend); "Don't show this again" persists to localStorage
 * and falls back to the original one-liner plus a docs link.
 */

import { useState } from "react"
import { Bot, ExternalLink } from "lucide-react"
import { SLASH_COMMANDS } from "@/lib/agent/slash-commands"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() ||
  "https://help.aquilla.app"
export const AGENT_GUIDE_URL = `${DOCS_URL}/automation/using-the-agent/`

const DISMISS_KEY = "aq.agent-guide-dismissed.v1"

export const EXAMPLE_PROMPTS = [
  "Find places where a key term is translated inconsistently",
  "Draft the untranslated cells in this chapter",
  "Check this chapter's translation against the source",
  "How much of this file is translated and validated?",
]

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, "1")
  } catch {
    // Private-mode storage failures just mean the guide shows again next time.
  }
}

export interface AgentEmptyStateProps {
  /** Prefill the composer with an example prompt. */
  onPromptSelect: (text: string) => void
}

export function AgentEmptyState({ onPromptSelect }: AgentEmptyStateProps) {
  const t = useT()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (dismissed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground">
        <Bot className="h-5 w-5" />
        <p className="text-xs">
          {t("agent.emptyState.dismissedNotice")}
        </p>
        <a
          href={AGENT_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] underline underline-offset-2 hover:text-foreground"
        >
          {t("agent.emptyState.userGuideLink")} <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="mx-auto flex max-w-md flex-col gap-3 text-muted-foreground">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 shrink-0" />
          <p className="text-xs">
            <RichMessage
              k="agent.emptyState.intro"
              values={{ you: <span className="font-medium text-foreground">{t("agent.emptyState.introYou")}</span> }}
            />
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium">{t("agent.emptyState.tryAsking")}</p>
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPromptSelect(prompt)}
              className="rounded-md border bg-muted/40 px-2 py-1.5 text-start text-xs hover:bg-muted hover:text-foreground"
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium">{t("agent.emptyState.shortcuts")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            {SLASH_COMMANDS.map((cmd) => (
              <div key={cmd.name} className="contents">
                <dt className="font-mono text-foreground/80">/{cmd.name}</dt>
                <dd>{t(cmd.descriptionKey)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <a
            href={AGENT_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] underline underline-offset-2 hover:text-foreground"
          >
            {t("agent.emptyState.userGuideLink")} <ExternalLink className="h-3 w-3" />
          </a>
          <button
            type="button"
            onClick={() => {
              writeDismissed()
              setDismissed(true)
            }}
            className="text-[11px] hover:text-foreground"
          >
            {t("agent.emptyState.dismiss")}
          </button>
        </div>
      </div>
    </div>
  )
}
