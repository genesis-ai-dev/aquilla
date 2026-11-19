import type { MouseEventHandler } from "react"
import { useEditorState, type Editor as TiptapEditor } from "@tiptap/react"
import { Bold, Code, Italic, Strikethrough, Underline as UnderlineIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { WordsThatFitMenu } from "@/components/WordsThatFitMenu"
import type { ForecastClient } from "@/lib/forecast/forecast-client"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

const MARKS = ["bold", "italic", "underline", "strike", "code"] as const
type Mark = (typeof MARKS)[number]

/** Bit 0 = "there is a selection"; bits 1.. = which of MARKS are active on it. */
const HAS_SELECTION = 1
const markBit = (mark: Mark) => 2 << MARKS.indexOf(mark)

/**
 * What the toolbar shows, as one number, so `useEditorState` re-renders it
 * only when that changes. With a collapsed selection the bubble is hidden
 * (`shouldShow` on the BubbleMenu wants `from !== to`), so the answer is a
 * constant 0 and typing does not render this component at all.
 */
function formattingToolbarState(editor: Pick<TiptapEditor, "state" | "isActive"> | null): number {
  if (!editor || editor.state.selection.empty) return 0
  let state = HAS_SELECTION
  for (const mark of MARKS) if (editor.isActive(mark)) state |= markBit(mark)
  return state
}

interface FormattingBubbleToolbarProps {
  editor: TiptapEditor
  /** Keeps the selection while a toolbar button is pressed. */
  onMouseDown: MouseEventHandler<HTMLDivElement>
  /** The project thesaurus button; absent when forecasting is off. */
  forecastClient?: ForecastClient
  cellId: string
}

/**
 * The selection bubble's formatting buttons (AQU-2654, decision 0013
 * "subscribe to what you render" and "closed is unmounted").
 *
 * These lived inline in TranslatedEditor, which re-rendered itself on every
 * ProseMirror transaction so the buttons' pressed state could follow the
 * selection — five tooltips and buttons, and the editor around them, per
 * keystroke. The toolbar now subscribes to exactly what it draws, and mounts
 * its buttons only while there is a selection for the bubble to show them on.
 */
export function FormattingBubbleToolbar({ editor, onMouseDown, forecastClient, cellId }: FormattingBubbleToolbarProps) {
  const t = useT()
  const state = useEditorState({ editor, selector: ({ editor: current }) => formattingToolbarState(current) })
  if (!(state & HAS_SELECTION)) return null
  const active = (mark: Mark) => Boolean(state & markBit(mark))
  return (
    // `relative z-30`: the row's floating action rail is z-20 and, since
    // round 5 made the mic/upload/TTS buttons permanent rather than
    // appearing only on an empty untranslated line, it is wide enough to
    // reach across this toolbar. Without a higher layer the rail's
    // buttons sit on top and swallow clicks meant for Bold/Inline
    // code/… — a formatting button that simply would not take.
    <div
      data-testid="formatting-bubble-menu"
      className="relative z-30 flex gap-0.5 rounded-lg bg-card p-0.5"
      onMouseDown={onMouseDown}
    >
      <AppTooltip content={t("editor.format.boldTooltip")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => editor.chain().focus().toggleBold().run()}
          aria-label={t("editor.format.bold")}
          className={cn("rounded-md", active("bold") && "bg-accent")}
        >
          <Bold className="h-3 w-3" />
        </Button>
      </AppTooltip>
      <AppTooltip content={t("editor.format.italicTooltip")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          aria-label={t("editor.format.italic")}
          className={cn("rounded-md", active("italic") && "bg-accent")}
        >
          <Italic className="h-3 w-3" />
        </Button>
      </AppTooltip>
      <AppTooltip content={t("editor.format.underlineTooltip")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          aria-label={t("editor.format.underline")}
          className={cn("rounded-md", active("underline") && "bg-accent")}
        >
          <UnderlineIcon className="h-3 w-3" />
        </Button>
      </AppTooltip>
      <AppTooltip content={t("editor.format.strikethrough")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => editor.chain().focus().toggleStrike().run()}
          aria-label={t("editor.format.strikethrough")}
          className={cn("rounded-md", active("strike") && "bg-accent")}
        >
          <Strikethrough className="h-3 w-3" />
        </Button>
      </AppTooltip>
      <AppTooltip content={t("editor.format.code")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => editor.chain().focus().toggleCode().run()}
          aria-label={t("editor.format.code")}
          className={cn("rounded-md", active("code") && "bg-accent")}
        >
          <Code className="h-3 w-3" />
        </Button>
      </AppTooltip>
      {forecastClient && <WordsThatFitMenu editor={editor} client={forecastClient} cellId={cellId} />}
    </div>
  )
}
