/**
 * markdown-plain.ts — chat UX improvements
 *
 * Deterministic markdown → plain text stripper for "Insert into cell".
 * Deliberately small: handles the constructs LLM replies actually produce
 * (fences, inline code, emphasis, headings, links, lists, blockquotes,
 * tables). Not a full CommonMark parser — cell text is short prose.
 */

export function markdownToPlainText(markdown: string): string {
  let text = markdown

  // Code fences: drop the fence lines, keep the code content.
  text = text.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/gm, "$1")
  text = text.replace(/^```[^\n]*$/gm, "")

  // Images before links: ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Links: [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")

  // Inline code: `code` → code
  text = text.replace(/`([^`]+)`/g, "$1")

  // Headings: strip leading #s
  text = text.replace(/^#{1,6}\s+/gm, "")

  // Blockquotes: strip leading >
  text = text.replace(/^>\s?/gm, "")

  // List markers: bullets and ordered.
  text = text.replace(/^\s*[-*+]\s+/gm, "")
  text = text.replace(/^\s*\d+\.\s+/gm, "")

  // Emphasis: bold/italic/strikethrough markers.
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2")
  text = text.replace(/(\*|_)(.*?)\1/g, "$2")
  text = text.replace(/~~(.*?)~~/g, "$1")

  // Tables: drop separator rows, collapse pipes to spaces.
  text = text
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).join(" ")
        : line,
    )
    .join("\n")

  // Horizontal rules.
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")

  // Collapse 3+ newlines and trim.
  return text.replace(/\n{3,}/g, "\n\n").trim()
}
