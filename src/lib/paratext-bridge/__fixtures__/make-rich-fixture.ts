// Builds MAT-rich.SFM: a synthetic, Paratext-shaped USFM book (BOM, CRLF,
// intro material, section headings, poetry, footnotes, cross references,
// character styles, an empty verse, a verse bridge, \va/\vp, \rem, non-ASCII).
// Synthetic because every richly-marked real text we have locally is under a
// no-derivatives licence. Regenerate with:
//   npx tsx src/lib/paratext-bridge/__fixtures__/make-rich-fixture.ts
import { writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const lines = [
  "﻿\\id MAT - Rich synthetic test book",
  "\\ide UTF-8",
  "\\rem Generated fixture; not scripture",
  "\\h Matthew",
  "\\toc1 The Gospel According to Matthew",
  "\\toc2 Matthew",
  "\\toc3 Mat",
  "\\mt1 Matthew",
  "\\imt1 Introduction",
  "\\ip The first paragraph of the introduction.",
  "\\ip The second paragraph, with a \\bk Book Name\\bk* reference.",
  "\\iot Outline",
  "\\io1 Genealogy \\ior 1:1-17\\ior*",
  "\\ie",
  "\\c 1",
  "\\s1 The Genealogy",
  "\\r (Luke 3:23-38)",
  "\\p",
  "\\v 1 The book of the genealogy of Jesus Christ\\f + \\fr 1:1 \\ft Or \\fq Messiah\\f*, the son of David.",
  "\\v 2",
  "\\v 3-4 Judah fathered Perez and Zerah by Tamar\\x - \\xo 1:3 \\xt Gen 38:29-30\\x*, Perez fathered Hezron.",
  "\\s1 Heading in the middle of a chapter",
  "\\p",
  "\\v 5 \\va 6\\va* Salmon fathered Boaz by \\nd Rahab\\nd*.",
  "\\v 6 \\vp 6b\\vp* Jesse fathered David the king.",
  "\\q1 Poetry begins in verse six,",
  "\\q2 and continues on an indented line.",
  "\\b",
  "\\m Back to prose — « Émmanuel » (naïve, façade).",
  "\\c 2",
  "\\s Wise men from the east",
  "\\p",
  "\\v 1 Now when Jesus was born\\f + \\fr 2:1 \\ft Bethlehem, \\fqa house of bread.\\f* in Bethlehem",
  "\\v 2 saying, \\wj Where is he\\wj* who has been born King of the Jews?",
  "\\s1 Second heading in chapter two",
  "\\s2 A sub-heading",
  "\\p",
  "\\v 3 Herod was troubled.",
  "\\li1 A list item inside verse three",
  "\\li2 and a nested one.",
  "\\v 4 Final verse with 日本語 and emoji 😀 text.",
  "",
]

writeFileSync(join(here, "MAT-rich.SFM"), Buffer.from(lines.join("\r\n"), "utf8"))
