import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentGroup,
} from "codex-web-app"
import { FileTextIcon, FileAudioIcon, XIcon, DownloadIcon } from "lucide-react"

export function UsfmFile() {
  return (
    <Attachment style={{ width: 280 }}>
      <AttachmentMedia>
        <FileTextIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>mark-draft.usfm</AttachmentTitle>
        <AttachmentDescription>USFM · 16 chapters · 42 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label="Remove attachment">
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

export function AudioTake() {
  return (
    <Attachment style={{ width: 280 }}>
      <AttachmentMedia>
        <FileAudioIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>mark-4-1-take-3.mp3</AttachmentTitle>
        <AttachmentDescription>Audio take · 0:38 · 612 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label="Download take">
          <DownloadIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

export function Uploading() {
  return (
    <Attachment state="uploading" style={{ width: 280 }}>
      <AttachmentMedia>
        <FileTextIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>genesis-source.usfm</AttachmentTitle>
        <AttachmentDescription>Uploading… 64%</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}

export function Group() {
  return (
    <AttachmentGroup style={{ width: 340 }}>
      <Attachment>
        <AttachmentMedia>
          <FileTextIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>mark-draft.usfm</AttachmentTitle>
          <AttachmentDescription>42 KB</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
      <Attachment>
        <AttachmentMedia>
          <FileAudioIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>mark-4-1-take-3.mp3</AttachmentTitle>
          <AttachmentDescription>0:38</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    </AttachmentGroup>
  )
}
