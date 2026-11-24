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
] as const satisfies readonly TutorialDef[]

export type TutorialId = (typeof TUTORIALS)[number]["id"]

export function tutorialById(id: string): TutorialDef {
  const found = TUTORIALS.find((tutorial) => tutorial.id === id)
  if (!found) throw new Error(`No tutorial "${id}". There are: ${TUTORIALS.map((t) => t.id).join(", ")}`)
  return found
}
