// A synthetic USFM book with every marker shape AQU-2743 was reported against.
//
// The real report came from Biblica's NIV 2011 Paratext export
// (`41MATusNIV11.SFM`, chapters 1–5), which is licensed and cannot live in this
// repo. This fixture reproduces the same marker SHAPES with public-domain
// wording, so the parity guard runs in the open-source copy too:
//
//   - a footnote with a nested `\+xt …|MAT 1:18\+xt*` cross-reference
//   - `\wj …\wj*` red-letter spans, one of them spanning a footnote
//   - `\m` text standing between an `\s1` heading and the next `\v`
//   - `\li1` genealogy lines
//   - `\q1`/`\q2` poetry with a `\b` blank line
//   - CRLF line endings throughout (a Paratext export's own)
//
// Written as a module rather than a `.usfm` file on purpose: the CRLF is half
// of what is under test, and a checked-in text file is at the mercy of
// `core.autocrlf` and every editor that opens it.

const LINES = [
  "\\id MAT - Synthetic Marker Shapes",
  "\\h Matthew",
  "\\toc1 The Gospel According to Matthew",
  "\\toc2 Matt.",
  "\\mt1 Matthew",
  "\\c 1",
  "\\s1 The Genealogy of Jesus the Messiah",
  "\\p",
  "\\v 1 This is the genealogy\\f + \\fr 1:1 \\ft Or \\fq is \\fqa an account of the origin\\f* of Jesus the Messiah\\f + \\fr 1:1 \\ft Or \\fq Jesus \\fqa Christ. \\fq Messiah \\ft (Hebrew) and \\fqa Christ \\ft (Greek) both mean \\fqa Anointed One\\ft ; also in \\+xt verse 18|MAT 1:18\\+xt*.\\f* the son of David, the son of Abraham:",
  "\\b",
  "\\li1",
  "\\v 2 Abraham was the father of Isaac,",
  "\\li1",
  "\\v 3 Isaac the father of Jacob,",
  "\\c 5",
  "\\p",
  "\\v 1 Now when Jesus saw the crowds, he went up on a mountainside and sat down. His disciples came to him,",
  "\\v 2 and he began to teach them.",
  "\\s1 The Beatitudes",
  "\\m He said:",
  "\\q1",
  "\\v 3 \\wj “Blessed are the poor in spirit,\\wj*",
  "\\q2 \\wj for theirs is the kingdom of heaven.\\wj*",
  "\\b",
  "\\q1",
  "\\v 4 \\wj “Blessed are those who mourn,\\f + \\fr 5:4 \\ft Or \\fq who grieve\\f* \\wj*",
  "\\q2 \\wj for they will be comforted.\\wj*",
  "",
]

/** The fixture, with the CRLF line endings a Paratext export writes. */
export const USFM_MARKER_SHAPES_CRLF = LINES.join("\r\n")

/** The same bytes with Unix line endings, for the "CRLF is not the variable"
 *  half of the parity guard. */
export const USFM_MARKER_SHAPES_LF = LINES.join("\n")
