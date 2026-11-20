/**
 * The comment button on a File check finding. It opens a small composer in
 * place, so a reviewer working down the findings can leave a note on a cell
 * and carry on, without the comments drawer replacing the findings they were
 * reading. "Open thread" is still there for when they need the conversation.
 */

import { useState } from "react"
import { ArrowUp, MessageSquare, MessageSquareText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  label: string
  /** Posts a new thread on the cell. */
  onAddComment: (text: string) => Promise<void>
  /** Opens the full comments drawer for the cell. */
  onOpenThread?: () => void
}

export function CheckFindingCommentPopover({ label, onAddComment, onOpenThread }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [posting, setPosting] = useState(false)
  const [failed, setFailed] = useState(false)
  // Session-local: says "you left a note here" so the list shows which
  // findings have been dealt with. Not a count of the cell's real threads.
  const [posted, setPosted] = useState(false)

  async function submit() {
    const body = text.trim()
    if (!body || posting) return
    setPosting(true)
    setFailed(false)
    try {
      await onAddComment(body)
      setText("")
      setPosted(true)
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setPosting(false)
    }
  }

  const Icon = posted ? MessageSquareText : MessageSquare
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={posted ? "h-6 px-1 text-primary" : "h-6 px-1"}
            aria-label={t("rules.checkDrawer.commentOnCellAriaLabel", { label })}
          />
        }
      >
        <Icon className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-64 gap-2">
        <p className="truncate text-xs font-medium">
          {t("rules.checkDrawer.commentOnCellAriaLabel", { label })}
        </p>
        <div className="relative">
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Same keys as the comments drawer: Enter posts, Shift+Enter breaks the line.
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              void submit()
            }}
            aria-label={t("comments.drawer.newThreadHeading")}
            placeholder={t("comments.drawer.newThreadPlaceholder")}
            rows={3}
            className="min-h-16 resize-none pb-8 text-xs"
          />
          <div className="absolute end-1.5 bottom-1.5">
            <Button
              type="button"
              size="icon-xs"
              variant={text.trim() ? "default" : "outline"}
              aria-label={t("comments.drawer.post")}
              onClick={() => void submit()}
              disabled={!text.trim() || posting}
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            {t("rules.checkDrawer.commentFailed")}
          </p>
        )}
        {onOpenThread && (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              setOpen(false)
              onOpenThread()
            }}
          >
            {t("rules.checkDrawer.openThreads")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
