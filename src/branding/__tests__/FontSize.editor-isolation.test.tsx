import { afterEach, describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { EditorSourceCellSurface, EditorTargetCellColumn } from "@/components/cell/EditorCellSurface"
import { resolveFontSizes } from "@/lib/store/file-view-prefs"
import { applyFontSizeScale, scaledDefaultCellFontSizePx } from "../FontSize"

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

describe("untouched editor cells follow the app font size (AQU-1170)", () => {
  it("renders default source and target text larger at Large than at Default", () => {
    applyFontSizeScale("large")
    const sizes = resolveFontSizes({}, "large")
    const { container } = render(
      <>
        <EditorSourceCellSurface fontSize={sizes.source}>source verse</EditorSourceCellSurface>
        <EditorTargetCellColumn fontSize={sizes.target}>target verse</EditorTargetCellColumn>
      </>,
    )
    const source = container.querySelector('[data-editor-cell-surface="source"]')
    const target = container.querySelector('[data-editor-cell-surface="target-column"]')
    expect(sizes.source).toBeGreaterThan(scaledDefaultCellFontSizePx("default"))
    expect(source).toHaveStyle({ fontSize: "16px" })
    expect(target).toHaveStyle({ fontSize: "16px" })
    expect(document.documentElement.style.fontSize).toBe("18px")
  })

  it("keeps an explicit target size while the untouched source tracks the scale", () => {
    applyFontSizeScale("extra-large")
    const sizes = resolveFontSizes({ targetFontSize: 13 }, "extra-large")
    const { container } = render(
      <>
        <EditorSourceCellSurface fontSize={sizes.source}>source verse</EditorSourceCellSurface>
        <EditorTargetCellColumn fontSize={sizes.target}>target verse</EditorTargetCellColumn>
      </>,
    )
    expect(container.querySelector('[data-editor-cell-surface="source"]')).toHaveStyle({
      fontSize: "18px",
    })
    expect(container.querySelector('[data-editor-cell-surface="target-column"]')).toHaveStyle({
      fontSize: "13px",
    })
  })
})
