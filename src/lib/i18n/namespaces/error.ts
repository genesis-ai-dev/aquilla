import { defineNamespace } from "./types"

export const error = defineNamespace({
  keys: {
    "error.generic.title": "Something went wrong",
  },
  context: {
    _context: {
      description:
        "Failure surfaces — the error boundary and failed-load states. Wording is " +
        "reassuring and non-technical: it tells the user something broke without " +
        "blaming them and without exposing internals.",
      screenshot: "error-state",
    },
    keys: {
      "error.generic.title": {
        description:
          "Heading of the generic failure panel shown when an unexpected error is " +
          "caught. A short sentence, not a button; sentence case, no trailing period.",
      },
    },
  },
  surfaces: [
    {
      id: "error-state",
      title: "Error state",
      route: "/project/:projectId",
      notes:
        "Generic failure surface (error boundary / failed load). Wording should be " +
        "reassuring and non-technical; the title is a heading, not a button.",
    },
  ],
})
