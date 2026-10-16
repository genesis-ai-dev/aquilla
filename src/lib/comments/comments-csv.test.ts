import { describe, expect, it } from "vitest"
import {
  COMMENTS_CSV_HEADER,
  commentThreadCsvRows,
  commentThreadsToCsv,
  commentsCsvFilename,
  type CommentCsvThread,
} from "./comments-csv"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

function comment(overrides: Partial<CommentRecord> & { commentId: string }): CommentRecord {
  return {
    projectId: "p1",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "GEN 1:1",
    parentCommentId: null,
    body: "looks good",
    resolved: false,
    authorId: "u1",
    authorLabel: "Anastasia",
    createdAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    updatedAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    deletedAt: null,
    ...overrides,
  }
}

function thread(overrides: Partial<CommentCsvThread> = {}): CommentCsvThread {
  return {
    root: comment({ commentId: "c1" }),
    replies: [],
    projectName: "Oromo NT",
    fileName: "Genesis",
    reference: "GEN 1:1",
    ...overrides,
  }
}

/** Split a CSV line on commas that sit outside a quoted field. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") { fields.push(field); field = "" }
    else field += ch
  }
  fields.push(field)
  return fields
}

function column(line: string, name: (typeof COMMENTS_CSV_HEADER)[number]): string {
  return splitCsvLine(line)[COMMENTS_CSV_HEADER.indexOf(name)]
}

describe("commentThreadCsvRows", () => {
  it("emits one row per message, root first then replies in creation order", () => {
    const rows = commentThreadCsvRows(thread({
      replies: [
        comment({
          commentId: "c3",
          parentCommentId: "c1",
          createdAt: Date.UTC(2026, 9, 3, 9, 0, 0),
          body: "later reply",
        }),
        comment({
          commentId: "c2",
          parentCommentId: "c1",
          createdAt: Date.UTC(2026, 9, 2, 13, 0, 0),
          body: "earlier reply",
        }),
      ],
    }))

    expect(rows.map((r) => r[COMMENTS_CSV_HEADER.indexOf("Message")]))
      .toEqual(["c1", "c2", "c3"])
    // Every row carries the thread's root id, so the conversation survives a
    // sort by Thread in a spreadsheet.
    expect(new Set(rows.map((r) => r[COMMENTS_CSV_HEADER.indexOf("Thread")]))).toEqual(new Set(["c1"]))
    expect(rows.map((r) => r[COMMENTS_CSV_HEADER.indexOf("Reply to")])).toEqual(["", "c1", "c1"])
  })

  it("reports the thread's resolved state on every one of its rows", () => {
    const rows = commentThreadCsvRows(thread({
      root: comment({ commentId: "c1", resolved: true }),
      replies: [comment({ commentId: "c2", parentCommentId: "c1", resolved: false })],
    }))
    expect(rows.map((r) => r[COMMENTS_CSV_HEADER.indexOf("Resolved")])).toEqual(["Yes", "Yes"])
  })

  it("keeps a deleted message's row but not its body", () => {
    const rows = commentThreadCsvRows(thread({
      replies: [comment({
        commentId: "c2",
        parentCommentId: "c1",
        body: "secret",
        deletedAt: Date.UTC(2026, 9, 4),
      })],
    }))
    expect(rows[1][COMMENTS_CSV_HEADER.indexOf("Deleted")]).toBe("Yes")
    expect(rows[1][COMMENTS_CSV_HEADER.indexOf("Comment")]).toBe("[deleted]")
  })

  it("renders a confirmed mention as plain @name", () => {
    const rows = commentThreadCsvRows(thread({
      root: comment({ commentId: "c1", body: "ask @[anastasia] about verse 3" }),
    }))
    expect(rows[0][COMMENTS_CSV_HEADER.indexOf("Comment")]).toBe("ask @anastasia about verse 3")
  })

  it("names the scope so file- and project-wide threads are not read as cell threads", () => {
    const fileThread = commentThreadCsvRows(thread({
      root: comment({ commentId: "c1", scopeKind: "file", cellId: null }),
      reference: "",
    }))
    const projectThread = commentThreadCsvRows(thread({
      root: comment({ commentId: "c1", scopeKind: "project", fileId: null, cellId: null }),
      fileName: "",
      reference: "",
    }))
    expect(fileThread[0][COMMENTS_CSV_HEADER.indexOf("Scope")]).toBe("File")
    expect(projectThread[0][COMMENTS_CSV_HEADER.indexOf("Scope")]).toBe("Project")
  })
})

describe("commentThreadsToCsv", () => {
  it("starts with the header and holds one line per message, CRLF separated", () => {
    const csv = commentThreadsToCsv([
      thread(),
      thread({ root: comment({ commentId: "c9", body: "second thread" }) }),
    ])
    const lines = csv.split("\r\n")
    expect(lines).toHaveLength(3)
    expect(splitCsvLine(lines[0])).toEqual([...COMMENTS_CSV_HEADER])
    expect(column(lines[2], "Comment")).toBe("second thread")
  })

  it("exports exactly the threads it is given — the caller's filtered list", () => {
    expect(commentThreadsToCsv([]).split("\r\n")).toHaveLength(1)
  })

  it("neutralizes a formula a commenter typed into a body (AQU-1281)", () => {
    const csv = commentThreadsToCsv([
      thread({ root: comment({ commentId: "c1", body: '=HYPERLINK("http://evil","click")' }) }),
    ])
    const body = column(csv.split("\r\n")[1], "Comment")
    expect(body.startsWith("'=")).toBe(true)
  })

  it("neutralizes a formula in a file name or author label too", () => {
    const csv = commentThreadsToCsv([
      thread({
        fileName: "+Genesis",
        root: comment({ commentId: "c1", authorLabel: "@anastasia" }),
      }),
    ])
    const line = csv.split("\r\n")[1]
    expect(column(line, "File")).toBe("'+Genesis")
    expect(column(line, "Author")).toBe("'@anastasia")
  })

  it("keeps commas, quotes and newlines inside one field (RFC 4180)", () => {
    const csv = commentThreadsToCsv([
      thread({ root: comment({ commentId: "c1", body: 'one, two\n"three"' }) }),
    ])
    // The embedded newline must not start a new record: header + one row, and
    // the row's last field holds the whole body.
    const rows = csv.split("\r\n")
    expect(rows).toHaveLength(2)
    expect(column(rows[1], "Comment")).toBe('one, two\n"three"')
  })

  it("timestamps in UTC ISO-8601 so copies compare across timezones", () => {
    const csv = commentThreadsToCsv([thread()])
    expect(column(csv.split("\r\n")[1], "Created")).toBe("2026-10-02T12:00:00.000Z")
  })
})

describe("commentsCsvFilename", () => {
  it("sanitizes the label and keeps the comments suffix", () => {
    expect(commentsCsvFilename("Oromo NT")).toBe("Oromo-NT-comments.csv")
    expect(commentsCsvFilename("  ")).toBe("comments-comments.csv")
    expect(commentsCsvFilename("")).toBe("comments-comments.csv")
  })
})
