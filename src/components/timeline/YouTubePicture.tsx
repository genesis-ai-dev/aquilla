// The video pane's picture when the linked video is a YouTube page.
//
// A watch URL is a web page, not a media resource, so a plain <video src> fires
// `error` on it and the pane showed "This video could not be loaded" for every
// YouTube link. `youtube-video-element` wraps the YouTube iframe player in an
// element that speaks the HTMLVideoElement API (currentTime, play/pause, muted,
// readyState, and the same media events), so the pane's clock, seek and
// transport logic drive it unchanged.
//
// One thing does NOT carry over: React only wires media-event props
// (onLoadedMetadata, onSeeked, …) on real <video>/<audio> tags. On a custom
// element they are silently dropped, so this component attaches them itself.

import { useEffect, useLayoutEffect, useRef, type DetailedHTMLProps, type RefObject, type SyntheticEvent, type VideoHTMLAttributes } from "react"
import "youtube-video-element"

import { youTubeVideoId } from "@/lib/video/youtube"

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "youtube-video": DetailedHTMLProps<VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement> & {
        /** Extra iframe player parameters, merged over the element's defaults. */
        config?: Record<string, string | number>
      }
    }
  }
}

type Props = VideoHTMLAttributes<HTMLVideoElement> & { ref: RefObject<HTMLVideoElement | null> }
/** The element forces YouTube's own captions on (cc_load_policy=1). The pane
 *  draws its captions itself, from the cells, so YouTube's must not stack on
 *  top of them. */
const PLAYER_CONFIG = { cc_load_policy: 0 }

type Handler = (e: SyntheticEvent<HTMLVideoElement>) => void

/** `onLoadedMetadata` → `loadedmetadata`. Media event names are all lower case. */
function eventName(prop: string): string {
  return prop.slice(2).toLowerCase()
}

function isHandlerProp(key: string, value: unknown): value is Handler {
  return key.startsWith("on") && typeof value === "function"
}

export function YouTubePicture({ ref, src, ...rest }: Props) {
  // Latest handlers, read at dispatch time, so listeners are attached once per
  // element rather than re-bound on every render (most are fresh closures).
  const propsRef = useRef<Record<string, unknown>>(rest)
  useLayoutEffect(() => {
    propsRef.current = rest
  })

  const handlerNames = Object.entries(rest)
    .filter(([k, v]) => isHandlerProp(k, v))
    .map(([k]) => k)
    .sort()
    .join(",")

  useEffect(() => {
    const el = ref.current
    if (!el || !handlerNames) return
    const bound = handlerNames.split(",").map((prop) => {
      const listener = (ev: Event) => {
        const h = propsRef.current[prop]
        if (!isHandlerProp(prop, h)) return
        // The pane's handlers only read `currentTarget`; hand them the element
        // in the shape React would have.
        h({ currentTarget: el, target: el, nativeEvent: ev, type: ev.type } as unknown as SyntheticEvent<HTMLVideoElement>)
      }
      el.addEventListener(eventName(prop), listener)
      return () => el.removeEventListener(eventName(prop), listener)
    })
    return () => bound.forEach((off) => off())
  }, [ref, handlerNames])

  const attrs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rest)) if (!isHandlerProp(k, v)) attrs[k] = v
  const id = src ? youTubeVideoId(src) : null

  return (
    <youtube-video
      {...(attrs as VideoHTMLAttributes<HTMLVideoElement>)}
      ref={ref}
      config={PLAYER_CONFIG}
      // Canonical form: the element's own matcher misses some share-link shapes.
      src={id ? `https://www.youtube.com/watch?v=${id}` : src}
    />
  )
}
