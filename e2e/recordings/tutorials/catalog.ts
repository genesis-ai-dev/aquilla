/**
 * The tutorial videos: one short how-to per thing a person does in Aquilla
 * (docs/TUTORIAL-VIDEOS.md). A video's title, who it is for and every line its
 * voice says live here, not in its spec, so the voice can be made and the
 * manifest written without a browser, and so a line can be translated by key.
 *
 * Plain TypeScript: scripts/tutorials/* (Node) and the specs (Playwright) both
 * import this file.
 */

export type Audience = "everyone" | "translators" | "reviewers" | "leads"

export interface TutorialDef {
  /** The video's slug: its file name, its URL and its key in videos.json. */
  id: string
  title: string
  audience: Audience
  /** What the voice says, in the order it is said. The first line is the
   * video's description. */
  lines: Record<string, string>
}

export const TUTORIALS = [
  {
    id: "find-your-way-around",
    title: "Find your way around a project",
    audience: "everyone",
    lines: {
      intro: "Here's how to find your way around a project.",
      files: "Your files are on the left. Click one to open it.",
      columns: "The source text is on the left. Your translation is on the right.",
      chapter: "Use the chapter picker at the top to move to another chapter.",
      progress: "The line at the bottom shows how much is translated and how much still needs validation.",
      outro: "That's the workspace. Everything else starts from here.",
    },
  },
  {
    id: "translate-a-verse",
    title: "Translate a verse",
    audience: "translators",
    lines: {
      intro: "Here's how to translate a verse.",
      find: "Find a verse with nothing on the right. This one is still empty.",
      click: "Click the empty space beside the source text.",
      type: "Type your translation.",
      save: "Click anywhere else. Aquilla saves it for you. There is no Save button.",
      outro: "The verse is translated and marked as checked by you. Your team can see it right away.",
    },
  },
  {
    id: "validate-a-verse",
    title: "Validate a verse",
    audience: "reviewers",
    lines: {
      intro: "Here's how to validate a verse.",
      read: "Read the source and the translation side by side.",
      ring: "When the translation is right, click the ring beside it.",
      done: "The ring turns green. That is your validation, with your name on it.",
      count: "The count at the bottom goes down as your team validates more verses.",
      outro: "To take it back, click the ring again and remove your name.",
    },
  },
  {
    id: "comment-on-a-verse",
    title: "Comment on a verse",
    audience: "everyone",
    lines: {
      intro: "Here's how to leave a comment on a verse.",
      open: "Point at the verse, open its menu, and choose Add comment.",
      write: "Write what you want your team to know.",
      post: "Click Post. Your team sees it beside the verse.",
      outro: "Anyone on the project can reply, and resolve the thread when it is settled.",
    },
  },
  {
    id: "export-your-work",
    title: "Export your work",
    audience: "leads",
    lines: {
      intro: "Here's how to export your work.",
      menu: "Open the file's menu at the top right.",
      choose: "Choose Export.",
      format: "Pick the format you need.",
      download: "Click Export, and the file downloads to your computer.",
      outro: "Your translations are inside, ready to share or publish.",
    },
  },
  {
    id: "find-help",
    title: "Find help when you're stuck",
    audience: "everyone",
    lines: {
      intro: "Here's how to find help when you're stuck.",
      menu: "Open the Help and community menu, and choose Help.",
      opens: "The help site opens in a new tab.",
      ask: "Type your question in plain words, and the help assistant answers from the guides.",
      browse: "Or browse the guides by topic on the left.",
      search: "To find a page fast, use Search at the top.",
      outro: "You can come back any time from the same menu.",
    },
  },
  {
    id: "living-memory",
    title: "Set up Living Memory",
    audience: "leads",
    lines: {
      intro: "Here's how to set up Living Memory, your project's guide for the AI.",
      open: "Open Living Memory from the sidebar.",
      parts: "It has five parts: instructions, terminology, examples, checks and source documents.",
      instructions: "Open Instructions. Write who the translation is for, the tone, and how to treat names.",
      saves: "It saves as you type, and every AI draft reads it.",
      outro: "As your team validates and corrects, Living Memory grows with you.",
    },
  },
  {
    id: "built-in-checks",
    title: "Catch mistakes with built-in checks",
    audience: "translators",
    lines: {
      intro: "Here's how built-in checks catch mistakes as you work.",
      flag: "When a line may have a problem, its line number turns red or amber.",
      open: "Click the line number to see what the check found.",
      example: "Here, the translation is missing the period the source ends with.",
      file: "To check a whole file at once, open the menu and choose Check file.",
      outro: "Fix the line, and the flag goes away.",
    },
  },
  {
    id: "add-a-rule",
    title: "Add a rule and fix what it flags",
    audience: "leads",
    lines: {
      intro: "Here's how to add a rule and fix the lines that break it.",
      add: "In Living Memory, open Checks and choose Add check.",
      write: "Write the rule: words the translation must or must not contain.",
      flag: "Lines that break it are marked. Click the marked words to see the rule.",
      panel: "The rule panel lists every line that breaks it.",
      fix: "Try to fix all proposes the fixes. Nothing changes until you review and apply them.",
    },
  },
  {
    id: "terminology",
    title: "Keep key terms consistent",
    audience: "everyone",
    lines: {
      intro: "Here's how to keep key terms consistent with terminology.",
      select: "Select a word in the source, and choose Add to terminology.",
      render: "Enter how your team translates it.",
      marked: "Now the term is marked in the source wherever it appears.",
      missed: "If a translation misses the agreed word, it's underlined so you can fix it.",
      page: "See every term on the Terminology page in the sidebar.",
    },
  },
  {
    id: "import-a-file",
    title: "Import a file",
    audience: "leads",
    lines: {
      intro: "Here's how to bring a file into your project.",
      open: "Click Import at the top of the editor.",
      choose: "Choose New source text, then Upload files.",
      formats: "Aquilla takes Scripture, documents, subtitles and more.",
      preview: "Check the preview. Nothing is added until you confirm.",
      confirm: "Click Confirm import, and the new file is ready to translate.",
    },
  },
  {
    id: "media-view",
    title: "Find your way around the Media view",
    audience: "everyone",
    lines: {
      intro: "Here's how to work with recordings in the Media view.",
      open: "Switch to Media with the buttons at the top of the file.",
      timeline: "The timeline runs across the top. Each recording sits on its line as a take.",
      source: "The source text runs above your recordings, so you can see what each one says.",
      below: "The file's lines are below, and the Station is in the tab beside them.",
      panels: "Use Panels to show or fold the timeline, the text and the Station.",
    },
  },
  {
    id: "trim-and-cut",
    title: "Trim and cut a recording",
    audience: "translators",
    lines: {
      intro: "Here's how to trim and cut a recording in the Station.",
      open: "Right-click a take on the timeline, and choose Edit in the Station.",
      trim: "Drag the Start and End flags to trim off the silence.",
      cut: "Drag across the waveform to select a part. Delete this cuts it out.",
      wait: "Changes wait until you save, and Undo takes them back.",
      save: "Click Save. The take keeps its history, so you can always go back.",
    },
  },
  {
    id: "volume-and-fades",
    title: "Set a recording's volume and fades",
    audience: "translators",
    lines: {
      intro: "Here's how to set a recording's volume and fades.",
      open: "Open the take in the Station.",
      volume: "Point at the waveform to see its volume line, then drag it up or down.",
      fade: "To fade in or out, drag the round knob at a top corner inward.",
      tint: "The part a fade quiets is tinted blue.",
      outro: "The timeline and your exports both use these settings.",
    },
  },
] as const satisfies readonly TutorialDef[]

export type TutorialId = (typeof TUTORIALS)[number]["id"]

export function tutorialById(id: string): TutorialDef {
  const found = TUTORIALS.find((tutorial) => tutorial.id === id)
  if (!found) throw new Error(`No tutorial "${id}". There are: ${TUTORIALS.map((t) => t.id).join(", ")}`)
  return found
}
