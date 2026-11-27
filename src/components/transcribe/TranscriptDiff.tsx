// The marks a Transcribe row draws over what speech recognition heard
// (transcript-cleanup/diff.ts has the comparison itself).
//
// <del> and <ins> carry the meaning, so a screen reader says "deletion" and
// "insertion" without colour. Inside a respelled word only the letters that
// changed are painted strongly; the rest of the word is tinted, so the eye
// lands on the accent or the capital that moved.

import { useEffect, useMemo, useRef, useState } from "react"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { diffWhileWriting, diffWriting, type DiffChunk, type DiffPiece } from "@/lib/transcript-cleanup/diff"
import { cn } from "@/lib/utils"

const DEL = "rounded-sm bg-destructive/10 text-destructive line-through decoration-destructive/50"
const DEL_CHANGED = "bg-destructive/25"
const INS = "rounded-sm bg-emerald-500/10 text-emerald-700 no-underline dark:text-emerald-400"
const INS_CHANGED = "bg-emerald-500/30 font-medium"

function Pieces({ pieces, changedClass }: { pieces: readonly DiffPiece[]; changedClass: string }) {
  return pieces.map((piece, i) => (
    <span key={i} className={piece.changed ? changedClass : undefined}>{piece.text}</span>
  ))
}

function Chunk({ chunk }: { chunk: DiffChunk }) {
  if (chunk.kind === "same") return <span>{chunk.text}</span>
  return (
    <>
      {chunk.del.length > 0 && (
        <del className={DEL} data-diff="del"><Pieces pieces={chunk.del} changedClass={DEL_CHANGED} /></del>
      )}
      {chunk.del.length > 0 && chunk.ins.length > 0 && " "}
      {chunk.ins.length > 0 && (
        <ins className={INS} data-diff="ins"><Pieces pieces={chunk.ins} changedClass={INS_CHANGED} /></ins>
      )}
    </>
  )
}

/**
 * `heard` with the changes that turn it into `written` drawn in place.
 * `writing`: the cleanup is still streaming, so only the part of `heard` the
 * reply has reached is marked; the rest waits, dimmed, behind a cursor.
 */
export function TranscriptDiff({ heard, written, writing = false }: { heard: string; written: string; writing?: boolean }) {
  const { chunks, pending } = useMemo(
    () => (writing ? diffWhileWriting(heard, written) : { chunks: diffWriting(heard, written), pending: "" }),
    [heard, written, writing],
  )
  return (
    <span className="text-foreground/80" data-testid="transcribe-diff">
      {chunks.map((chunk, i) => (
        <span key={i}>
          {i > 0 && " "}
          <Chunk chunk={chunk} />
        </span>
      ))}
      {writing && (
        <>
          {chunks.length > 0 && " "}
          <LoadingCursor plain />
          {pending && <span className={cn("text-muted-foreground/70", "ms-1")} data-diff="pending">{pending}</span>}
        </>
      )}
    </span>
  )
}

/** How long typing a line out takes, whatever its length. */
const TYPE_MS = 450
const TYPE_TICK_MS = 30

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/**
 * Text typed out behind a cursor as it mounts: what speech recognition heard,
 * shown the moment it arrives. It is all there within TYPE_MS, so a long line
 * is not made to wait, and at once for a reader who asked for less motion.
 */
export function TypedText({ text }: { text: string }) {
  // The text whose typing has finished; anything else is still being typed.
  const [typedText, setTypedText] = useState<string | null>(() => (prefersReducedMotion() ? text : null))
  // A different text restarts the typing (adjusted during render).
  const [forText, setForText] = useState(text)
  if (forText !== text) {
    setForText(text)
    setTypedText(prefersReducedMotion() ? text : null)
  }
  const done = typedText === text
  // AQU-2655: each tick writes the letters straight into this span, not
  // through React state. A state update per 30 ms tick was one React commit
  // per tick — fifteen per row, most of the commits in a "transcribe all"
  // pass. React commits when the typing starts and once when it is done (the
  // cursor goes). While it types the span has no React children, so React
  // never touches the letters the interval writes.
  const lettersRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const node = lettersRef.current
    if (done || !node) return
    const step = Math.max(1, Math.ceil(text.length / (TYPE_MS / TYPE_TICK_MS)))
    let shown = 0
    node.textContent = ""
    const id = setInterval(() => {
      shown = Math.min(text.length, shown + step)
      node.textContent = text.slice(0, shown)
      if (shown >= text.length) {
        clearInterval(id)
        setTypedText(text)
      }
    }, TYPE_TICK_MS)
    return () => clearInterval(id)
  }, [done, text])
  return (
    <span className="text-foreground/80" data-testid="transcribe-typed" data-typing={!done}>
      <span ref={lettersRef}>{done ? text : undefined}</span>
      {!done && <LoadingCursor plain />}
    </span>
  )
}
