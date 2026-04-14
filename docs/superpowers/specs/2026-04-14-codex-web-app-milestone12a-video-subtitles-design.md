# Codex Web App — Milestone 12a: Video Playback with Live Subtitles

## Overview

Attach a video to any VTT/SRT file. Play it above the editor table with live subtitles generated from current translated cells. Click a cue to seek. The currently-playing cue highlights in the table.

## Scope (A)

- In scope: URL + local file attachment, subtitle overlay from cells, click-to-seek, active-cue highlighting + auto-scroll, resizable video panel
- Not in scope: timeline editor with drag-to-adjust cue times, audio recording, transcription, PiP / collapsible modes

## Data Model

### Per-file attachment

Stored in the file's `Y.Map("meta")`:

```
meta.set("videoUrl", string)          // optional — remote URL
meta.set("videoLocalFileId", string)  // optional — IndexedDB blob ref
meta.set("videoFileName", string)     // optional — human-friendly name
```

Only ONE of `videoUrl` / `videoLocalFileId` is set at a time. If both somehow exist, `videoLocalFileId` wins (local file takes precedence on the device that has it).

Video URL syncs across peers (it's in Yjs). Local file blobs do NOT sync — each peer who wants a local copy uploads their own. A peer without the blob for a `videoLocalFileId` falls back to showing a "video not available on this device, paste URL instead" prompt.

### IndexedDB

Store local video blobs in the existing `originals` store, keyed as `codex:video:{videoFileId}` (the same pattern as `codex:original:{fileId}` used for DOCX originals). No schema change needed.

### Types

Add to `src/lib/parsers/types.ts`:

```typescript
export interface VideoAttachment {
  videoUrl?: string
  videoLocalFileId?: string
  videoFileName?: string
}
```

## Subtitle Generation

`src/lib/video/vtt-generator.ts`:

```typescript
// Convert cells with context like "00:00:01.000 --> 00:00:04.000" into a WebVTT
// string, using the translated text when non-empty (falls back to original).
export function generateVttFromCells(cells: CellData[]): string

// Create a Blob URL for the VTT string. Caller owns the URL and must call
// URL.revokeObjectURL when done.
export function createVttBlobUrl(vtt: string): string
```

Parse the context field with a regex matching VTT and SRT timestamps:
- VTT: `HH:MM:SS.mmm --> HH:MM:SS.mmm`
- SRT: `HH:MM:SS,mmm --> HH:MM:SS,mmm` (comma instead of period, normalize on output)

Skip cells whose context doesn't parse as a timestamp range.

The VTT is regenerated whenever `cells` changes. Old blob URLs are revoked to avoid leaking.

## Video Player

`src/components/VideoPlayer.tsx`:

Uses the HTML5 `<video>` element directly. `react-player` would add a dependency; we only need the basics and already use the browser's native player elsewhere (for `<audio>` in previous discussions).

```tsx
interface VideoPlayerProps {
  src: string               // resolved URL (remote or blob URL)
  subtitleUrl?: string      // VTT blob URL; passed as <track>
  onTimeUpdate?: (seconds: number) => void
  onDurationChange?: (seconds: number) => void
  height: number
}
```

Renders:

```html
<video controls>
  <source src={src}>
  <track kind="subtitles" src={subtitleUrl} default />
</video>
```

Listens to:
- `timeupdate` event → calls `onTimeUpdate(video.currentTime)`
- `durationchange` event → calls `onDurationChange(video.duration)`

Exposes imperative API via `forwardRef`:

```typescript
export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void
  getCurrentTime: () => number
}
```

## Resizable Panel

The video sits in a container above the editor table. A drag handle at the bottom edge of the video panel lets the user adjust height. State persists in localStorage keyed by `codex:video-height`.

- Default height: 320px
- Min height: 120px
- Max height: 70% of viewport

Implementation via a `<div>` with `onMouseDown`, listening to `mousemove`/`mouseup` on the document.

## Attachment UI

A "Video" button in the toolbar (`Film` icon from lucide-react) appears only when the active file is VTT or SRT. Opens a `VideoAttachmentDialog`:

- Tab 1: **From URL** — text input, validated as URL format
- Tab 2: **Upload file** — drag-drop zone + file picker, `accept="video/*"`
- Current attachment shown at top with a Remove button
- Save writes to Y.Map meta and (for file) stores blob in IndexedDB

## Click-to-Seek

Each cell row in a VTT/SRT file gets a "play" icon (`Play` from lucide-react) in the left gutter when video is attached. Click → calls `videoPlayerRef.seekTo(cueStartSeconds)`.

## Active-Cue Highlighting

During playback, `onTimeUpdate` fires with the current time. We compute which cell's cue range contains the current time. That cell's row gets a subtle highlight class (`bg-primary/5` + left border). Auto-scroll the virtualizer to that cell only if it's been stable for > 500ms (so we don't thrash during rapid time updates).

## File Structure

```
src/
├── lib/
│   ├── video/
│   │   ├── vtt-generator.ts              # NEW
│   │   ├── vtt-generator.test.ts         # NEW TDD
│   │   └── video-store.ts                # NEW: IndexedDB blob CRUD for videos
│   └── parsers/
│       └── types.ts                      # MODIFY: add VideoAttachment interface
├── components/
│   ├── VideoPlayer.tsx                   # NEW
│   ├── VideoAttachmentDialog.tsx         # NEW
│   ├── ResizableVideoPanel.tsx           # NEW: drag-to-resize wrapper
│   ├── Toolbar.tsx                       # MODIFY: add Film button when applicable
│   ├── ProjectWorkspace.tsx              # MODIFY: wire video panel above EditorTable
│   └── EditorTable.tsx                   # MODIFY: optional active-cue highlight + play buttons
└── hooks/
    └── useVideoAttachment.ts             # NEW: load video src from Y meta + IDB
```

## File-type Gating

The Film button and video panel only appear when `file.type === "vtt" || file.type === "srt"`.

## Testing

Unit tests for `vtt-generator`:
- Parses VTT-style context into cue times
- Parses SRT-style context (comma) into cue times
- Uses translated text when non-empty, falls back to original
- Skips cells without timestamp context
- Produces well-formed WebVTT string

Manual tests (E2E):
- Attach a URL, verify playback + subtitles visible
- Upload a local video, verify playback + subtitles visible
- Edit a cue's translation → subtitle updates live while playing
- Click a cue row → video seeks
- Play → active cue highlights and auto-scrolls into view
- Resize video panel via drag handle

## Not In Scope (flagged for M12b)

- Timeline editor (waveform view, drag cue edges to adjust timing)
- Per-cell audio recording via `MediaRecorder`
- AI transcription
- Audio waveform rendering
- PiP floating player
- Cross-peer video blob sync (explicitly declined for bandwidth)
