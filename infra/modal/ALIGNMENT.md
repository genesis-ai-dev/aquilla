# Script alignment

The media timeline opens **Sources → Align script**. You can paste wording or
choose a UTF-8 text file. Paragraph breaks define segments. The editable review
shows each segment's initial confidence, wording, and timing. You can listen to
a segment, correct it, and confirm uncertain matches before saving.

Saving creates an independent text track by default. Selecting an existing text
track requires consent to overwrite its displayed segment count. Original media,
other tracks, translations, and recorded takes remain available. Uploaded script
files retain their original bytes, including UTF-8 markers and line endings.

## Timing evidence

The client first reuses matching source word timings, including each source
segment's trim offset. Complete, unambiguous matches avoid another model run.
Otherwise, the client tries Whisper word timings before requesting the acoustic
alignment service.

Word-match confidence measures the proportion of supplied words that match the
transcript. Acoustic confidence comes from the alignment model. The review labels
these separately. Neither score guarantees accurate timing. Missing or ambiguous
evidence requires review; invalid timings prevent publication.

## Worker and Modal configuration

The worker needs `AQUILLA_PG`, `SNAPSHOTS`, and `SYNC_SECRET_KEY`, plus:

- `ALIGNMENT_MODAL_URL`: the HTTPS start endpoint returned by deploying
  `infra/modal/alignment.py`.
- `ALIGNMENT_SHARED_SECRET`: a private random secret shared with the Modal
  secret named `aquilla-alignment`. Keep this out of source control and the SPA.
- `ALIGNMENT_PUBLIC_BASE`: the public HTTPS origin of the sync worker that owns
  the uploaded audio. Modal must reach its alignment audio and callback routes.

Apply migration `db/postgres/migrations/0117_alignment_jobs.sql` through the
normal migration workflow before enabling acoustic alignment. Get Ryder's
approval before changing the shared development database. The isolated E2E
database uses the schema containing the alignment job table.

The Modal deployment uses `modal deploy infra/modal/alignment.py`. It requires
the matching `ALIGNMENT_SHARED_SECRET` in the `aquilla-alignment` Modal secret.
The browser uses its existing per-file worker token. It never receives the
Modal secret or calls the service directly.

## Job lifecycle

The authenticated start route creates a job and sends the supplied paragraphs
to Modal with a job-specific audio capability. The service fetches the original
R2 audio through that capability and posts its result to the authenticated
callback. The client polls file-scoped status and validates the returned
paragraphs, clocks, and confidence before showing the review.

Jobs expire after 30 minutes. Expiration clears their audio capability and
prevents late completion from replacing the failed state. Canceling the review
stops client requests and discards results; already-started model work expires
through the same server lifecycle.

## Verification

Targeted coverage includes real Whisper timing output through event projection,
paragraph alignment through cue conversion and worker publication, exact original
script downloads, publication retries after lost responses, and review consent.
The media-caption smoke spec checks pasted and uploaded scripts through the
browser, database, and R2. Worker tests cover authorization, strict callbacks,
job races, and expiration. Python tests cover model results and bounded network
transport.

A live acoustic browser check needs the deployed Modal service to reach the
test worker. Keep that environment separate from the shared database. Any
temporary public test endpoint must expose only authenticated alignment audio
and callbacks, with explicitly approved test media.
