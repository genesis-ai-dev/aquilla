import { afterEach, describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { EditorSourceCellSurface, EditorTargetCellColumn } from "@/components/cell/EditorCellSurface"
import { applyFontSizeScale } from "../FontSize"

afterEach(() => {
  document.documentElement.style.removeProperty("font-size")
})

describe("app font size vs editor cell px (AQU-1169 negative case)", () => {
  it("leaves source and target cell text at their View-settings px size", () => {
    applyFontSizeScale("large")
    const { container } = render(
      <>
        <EditorSourceCellSurface fontSize={16}>source verse</EditorSourceCellSurface>
        <EditorTargetCellColumn fontSize={18}>target verse</EditorTargetCellColumn>
      </>,
    )
    const source = container.querySelector('[data-editor-cell-surface="source"]')
    const target = container.querySelector('[data-editor-cell-surface="target-column"]')
    expect(source).toHaveStyle({ fontSize: "16px" })
    expect(target).toHaveStyle({ fontSize: "18px" })
    expect(document.documentElement.style.fontSize).toBe("18px")
  })
})
