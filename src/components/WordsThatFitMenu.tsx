/**
 * WordsThatFitMenu — the project thesaurus on the selection bubble.
 *
 * For a single selected word, lists the words this project's translation uses
 * in the same slots (BIA with the word blanked out of every cell containing
 * it, plus this sentence). One click on a chip replaces the selection — a
 * direct action, no select-then-confirm. The replacement is an ordinary text
 * transaction, so it commits through the editor's normal idle/blur path.
 */

import { useState } from "react"
import { useEditorState, type Editor as TiptapEditor } from "@tiptap/react"
import { WholeWord } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { ForecastClient } from "@/lib/forecast/forecast-client"
import type { FitResult } from "@/lib/forecast/forecast-protocol"
import { matchCase, selectedSingleWord } from "@/lib/forecast/words-that-fit"
import { useT } from "@/lib/i18n/I18nProvider"

interface WordsThatFitMenuProps {
  editor: TiptapEditor
  client: ForecastClient
  cellId: string
}

export function WordsThatFitMenu({ editor, client, cellId }: WordsThatFitMenuProps) {
  const t = useT()
  // The editor does not re-render React on every transaction; subscribe to
  // the selection so the button follows it.
  const key = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e ? selectedSingleWord(e) : null
      return s ? `${s.from}:${s.to}:${s.word}` : ""
    },
  })
  const selection = key ? selectedSingleWord(editor) : null
  const [state, setState] = useState<{ key: string; fits: FitResult[] | null } | null>(null)
  if (!selection) return null
  const open = state?.key === key
  const fits = open ? state.fits : null

  const toggle = () => {
    if (open) {
      setState(null)
      return
    }
    setState({ key, fits: null })
    const { doc } = editor.state
    const left = doc.textBetween(0, selection.from, " ", " ")
    const right = doc.textBetween(selection.to, doc.content.size, " ", " ")
    void client
      .wordsThatFit(selection.word, left, right, { excludeCellId: cellId, limit: 8 })
      .then((result) => setState((prev) => (prev?.key === key ? { key, fits: result } : prev)))
      .catch(() => setState((prev) => (prev?.key === key ? { key, fits: [] } : prev)))
  }

  const replace = (word: string) => {
    const { from, to } = selection
    const text = matchCase(selection.word, word)
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(text, from, to)
        return true
      })
      .run()
    setState(null)
  }

  return (
    <div className="relative">
      <AppTooltip content={t("editor.wordsThatFit.button")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={toggle}
          aria-label={t("editor.wordsThatFit.button")}
          aria-expanded={open}
          data-testid="words-that-fit-button"
          className={open ? "rounded-md bg-accent" : "rounded-md"}
        >
          <WholeWord className="h-3 w-3" />
        </Button>
      </AppTooltip>
      {open && (
        <div
          role="group"
          aria-label={t("editor.wordsThatFit.button")}
          data-testid="words-that-fit-panel"
          className="absolute left-0 top-full z-30 mt-1 flex w-56 flex-wrap gap-1 rounded-lg border border-border bg-card p-1.5 shadow-md"
        >
          {fits === null ? (
            <span className="px-1 text-xs text-muted-foreground">…</span>
          ) : fits.length === 0 ? (
            <span className="px-1 text-xs text-muted-foreground">{t("editor.wordsThatFit.empty")}</span>
          ) : (
            fits.map((fit) => (
              <Button
                key={fit.word}
                type="button"
                variant="secondary"
                size="xs"
                className="rounded-md"
                aria-label={t("editor.wordsThatFit.replace", { word: fit.word })}
                onClick={() => replace(fit.word)}
              >
                {matchCase(selection.word, fit.word)}
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
