/**
 * AQU-2467: the crop view of the Report a problem dialog. Shows the frame the
 * user just captured; they keep all of it or drag a box around the part that
 * matters. Pointer events, so a finger works as well as a mouse.
 *
 * The box is drawn in displayed (CSS) pixels and mapped to the natural image by
 * `displayBoxToNaturalRect`; cutting and downscaling happen in the caller
 * (`cropImage`), so this component only reports a rectangle or null.
 */

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  boxFromDrag,
  displayBoxToNaturalRect,
  isUsableBox,
  type Point,
  type Rect,
} from "@/lib/screenshot-crop"

interface Props {
  /** Object URL of the captured frame. The caller owns it and revokes it. */
  imageUrl: string
  /** `null` keeps the whole image. Otherwise the box in natural pixels. */
  onConfirm: (rect: Rect | null) => void
  onDiscard: () => void
  busy?: boolean
}

export function ScreenshotCropper({ imageUrl, onConfirm, onDiscard, busy = false }: Props) {
  const t = useT()
  const imgRef = useRef<HTMLImageElement>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [box, setBox] = useState<Rect | null>(null)

  function pointFor(e: React.PointerEvent): Point {
    const r = imgRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  function boundsNow() {
    const r = imgRef.current?.getBoundingClientRect()
    return { width: r?.width ?? 0, height: r?.height ?? 0 }
  }

  function handleDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setStart(pointFor(e))
    setBox(null)
  }

  function handleMove(e: React.PointerEvent) {
    if (!start) return
    setBox(boxFromDrag(start, pointFor(e), boundsNow()))
  }

  function handleUp() {
    setStart(null)
    // A stray click or a sliver is not a selection.
    setBox((current) => (isUsableBox(current) ? current : null))
  }

  function useSelection() {
    const img = imgRef.current
    if (!img || !isUsableBox(box)) return
    onConfirm(
      displayBoxToNaturalRect(box, boundsNow(), {
        width: img.naturalWidth,
        height: img.naturalHeight,
      }),
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("nav.report.cropHint")}</p>
      <div
        className="relative mx-auto w-fit max-w-full cursor-crosshair touch-none select-none overflow-hidden rounded-md border"
        data-testid="crop-surface"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        <img
          ref={imgRef}
          src={imageUrl}
          alt={t("nav.report.cropAlt")}
          draggable={false}
          className="block max-h-[55vh] max-w-full"
        />
        {box && (
          <div
            className="pointer-events-none absolute border-2 border-primary bg-primary/10"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          />
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={() => onConfirm(null)} disabled={busy}>
          {t("nav.report.keepWholeImage")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={useSelection}
          disabled={busy || !isUsableBox(box)}
        >
          {t("nav.report.useSelection")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={busy}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  )
}
