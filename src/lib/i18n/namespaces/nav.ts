import { defineNamespace } from "./types"

export const nav = defineNamespace({
  keys: {
    "nav.projects": "Projects",
    "nav.settings": "Settings",
    "nav.search": "Search",
  },
  context: {
    _context: {
      description:
        "Top-level workspace navigation — links and controls in the left sidebar and " +
        "app header that move the user between major areas. Rendered in a narrow " +
        "fixed-width column, so long translations wrap or clip.",
      screenshot: "workspace-nav",
      maxLength: 24,
    },
    keys: {
      "nav.projects": {
        description:
          "Sidebar link to the list of translation projects the user belongs to. Plural " +
          "noun naming a destination, not an action.",
      },
      "nav.settings": {
        description:
          "Sidebar link to the settings area. Plural noun naming a destination.",
      },
      "nav.search": {
        description:
          "Control that opens search across the project's cells. Noun or verb depending " +
          "on what reads naturally as a nav label in the target language.",
      },
    },
  },
  surfaces: [
    {
      id: "workspace-nav",
      title: "Workspace navigation",
      route: "/project/:projectId",
      notes:
        "Left sidebar and top chrome of a project. Navigation labels sit in a narrow " +
        "column, so translations that are much longer than the English will wrap or clip.",
    },
  ],
})
