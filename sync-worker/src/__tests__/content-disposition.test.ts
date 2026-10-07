import { describe, it, expect } from "vitest"
import { attachmentDisposition } from "../events/content-disposition"

describe("attachmentDisposition", () => {
  it("neutralises CR/LF, quotes, backslash, semicolons", () => {
    const h = attachmentDisposition('a"\r\nX-Evil: 1;\\b.docx')
    expect(h).not.toMatch(/[\r\n]/)
    expect(h.split("filename*")[0]).not.toMatch(/X-Evil: 1;/)
    expect(h).toMatch(/^attachment; filename="[^"\;]*"; filename\*=UTF-8''/)
  })
  it("keeps non-latin names valid for header values", () => {
    const h = attachmentDisposition("Библия.zip")
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true)
  })
})
