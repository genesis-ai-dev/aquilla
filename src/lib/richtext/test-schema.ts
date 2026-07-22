import { Schema } from "@tiptap/pm/model"

// Minimal doc/paragraph/text schema for plugin tests. @tiptap/pm dropped its
// re-export of prosemirror-schema-basic in 3.28, and these tests only need
// plain paragraphs anyway.
export const basicSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
})
