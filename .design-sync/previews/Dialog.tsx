import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
} from "codex-web-app"

export function DeleteProject() {
  return (
    <Dialog open modal={false}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete “Gospel of Mark”?</DialogTitle>
          <DialogDescription>
            This removes the Tok Pisin project and its 678 verses for all
            contributors. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant="destructive">Delete project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ShareTranslation() {
  return (
    <Dialog open modal={false}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Share translation</DialogTitle>
          <DialogDescription>
            Invite a consultant to review the Luke drafts.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p style={{ fontSize: 14, margin: 0, color: "var(--muted-foreground)" }}>
            Reviewers can read every verse and leave comments, but cannot edit
            committed translations.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline">Copy link</Button>
          <Button>Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
