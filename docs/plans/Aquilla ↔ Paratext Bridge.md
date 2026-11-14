# Aquilla ↔ Paratext Bridge

Nov 5, 2026 · @Ryder Wishart

## Goal and principles

A Paratext user opens Aquilla, sees the Paratext projects on their machine, edits one in place, and lets Paratext Send/Receive carry the changes to the team. Aquilla never takes the project out of Paratext.

- **Paratext is the master for text.** The project folder on disk is the source of truth.
- **Aquilla is an overlay.** It holds AI drafts, health scores, Living Memory, comments and pending edits, keyed to Paratext references.
- **Paratext owns history and sync.** Aquilla never commits, pulls or pushes Mercurial changes.
- **Aquilla writes only the bytes it means to change.** Every other byte in the file stays identical.
- **Aquilla obeys Paratext permissions** before it writes anything.

## Decisions so far

Four decisions are firm; three are proposals waiting on the spike.

| Decision | Status | Why |
| --- | --- | --- |
| Aquilla edits the Paratext working copy; Paratext does Send/Receive | Decided | Teams keep their existing sync, history and permissions |
| No source rows per project: cells derive from the file blob, `anyCustomFilters(tmsFriendlyFilter(fileblob))` | Decided | First real use of the planned shift away from n source records |
| Unit IDs are deterministic; change is tracked by content hash | Decided | Overlay data stays anchored while the text changes underneath |
| Aquilla never loses a change: live sync from Paratext, clobber detection, mine-or-theirs resolution, full history | Decided | Paratext can overwrite Aquilla edits from a stale in-memory copy at any save |
| The Paratext folder is the master for text; Aquilla stores only an overlay | Proposed | Avoids a second source of truth and a custom reconcile layer |
| Version 1 runs in the Tauri app and may write while Paratext runs, guarded by clobber detection and a per-book hold | Proposed | A browser tab cannot watch the folder or check for Paratext |
| SHA-256 for every hash | Proposed | Native in the browser, Workers, Rust and Postgres, so all runtimes agree |

## Source model

A file-backed lane stores no source rows: its cells are a pure function of the file, `cells = anyCustomFilters(tmsFriendlyFilter(fileblob))`. Either lane can be file-backed. The team's Paratext project is the editable target lane; another Paratext project can be a read-only source lane. This also removes the per-verse row cost that pushed the store past D1's ceiling.

&#91;embedded content: bridge data flow · read path, overlay join, write-back\]

Units are derived from the file on every open; only the highlighted overlay lives in Postgres, and write-back touches only the spans of edited units.

### Terms

- **Blob**: the raw bytes of one file (one USFM book). Blob hash = SHA-256 of those bytes.
- **Unit**: one segment the filter emits: `{id, kind, text, span, rawHash, textHash}`. The span is the byte range in the blob.
- **Overlay**: everything Aquilla adds, stored in Postgres, keyed by unit ID.

### Pipeline

1. Read `Settings.xml`: project GUID, file naming, encoding, versification, normalization, stylesheet.
2. Read each book file as a blob and hash it.
3. `tmsFriendlyFilter` parses USFM into units with byte spans. Same bytes and same settings always give the same units.
4. `anyCustomFilters` apply project rules: drop intro material, split footnotes into their own units, hide `\rem`. Also pure.
5. Join units to overlay rows on unit ID. A base hash that no longer matches marks that overlay row stale.

### Unit IDs

IDs come from Paratext references, not from content. The ID stays fixed when the text changes; the hash changes. Grammar: `{BOOK} {chapter}:{verse}[/{marker}#{n}]`. Full key: `pt:{stateId}:{unitId}`, where the state id is `{projectGuid}@{project folder}`: the GUID is the 40-hex `id` from `Settings.xml` (the same value the registration token carries), and the folder is part of the key because one project can sit in two folders on a computer (Paratext 10 and Paratext Lite each keep a copy).

| Content | Example ID | Rule |
| --- | --- | --- |
| Verse text | `MAT 5:3` | `\v` number as written |
| Verse bridge | `MAT 5:3-4` | Bridge kept as written |
| Heading inside verse 12's span | `MAT 5:12/s1#0` | Marker plus occurrence index within the verse span |
| Heading before verse 1 | `MAT 5:0/s1#0` | Chapter text before `\v 1` is verse 0 |
| Footnote in verse 3 | `MAT 5:3/f#0` | Only when a custom filter splits notes out |
| Book header or intro | `MAT 0:0/ip#2` | Chapter 0 holds `\id`, `\h`, `\toc`, intro paragraphs |

- The occurrence index counts that marker inside one verse span. A new heading earlier in the same span shifts the index; the hash check flags the overlay instead of misapplying it.
- Structural edits (split a verse, merge a bridge, renumber) change IDs. Treat them as retire plus create, with an optional carry-over map (bridge `3-4` covers `3` and `4`).
- `\va` and `\vp` (alternate and published verse numbers) never affect IDs.
- IDs must not change between parser versions. Golden tests lock the ID output on real projects.

### Hashes

- `rawHash`: SHA-256 of the exact bytes in the span. It guards write-back.
- `textHash`: SHA-256 of normalized text (NFC, collapsed whitespace, canonical markers). It drives overlay staleness, translation memory lookup and dedupe across projects.
- Snapshot hash: SHA-256 over the sorted `(fileName, blobHash)` pairs plus the `Settings.xml` hash.

### What the database stores

| Store | Key | Holds |
| --- | --- | --- |
| `source_snapshot` | project GUID + snapshot hash | Blob hashes, filter config hash, parser version |
| `unit_overlay` | project GUID + unit ID | AI draft, health, memory links, comments, `baseTextHash` at write time |
| `pending_edit` | project GUID + unit ID | New text, `baseRawHash`; cleared after write-back |
| `unit_cache` (R2 or local disk) | parser version + filter hash + blob hash | Derived units as JSON; a cache, safe to delete |

A 66-book Bible yields 66 cache objects, not \~31,000 source rows. Events in the event log reference `(unitId, baseHash)` instead of cell row IDs.

## Write-back

Aquilla writes one book at a time by splice, then proves that only the intended units changed. If any check fails, nothing is written.

1. Check that the book is not on hold after a clobber (see Live sync and clobber protection).
2. Check permission: the registered Paratext user may edit this book and chapter, per `ProjectUserAccess.xml`.
3. Re-read the file and derive units again.
4. For each pending edit, the current `rawHash` must equal its `baseRawHash`. If not, mark a conflict and skip that unit.
5. Check marker integrity: the new text keeps the same protected markers (footnotes, cross references, character styles) unless the user changed them on purpose. The existing `placeholder-integrity` rule can do this.
6. Splice the new bytes into their spans from the end of the file to the start, so earlier offsets stay valid.
7. Encode with the project encoding; keep the BOM state and line endings as found.
8. Derive units from the new bytes and assert: the units whose `rawHash` changed are exactly the edits applied, and the set of unit IDs is unchanged unless a structural edit was requested.
9. Copy the original file to a backup location outside the project folder, then write the new bytes to the same path.
10. Clear the applied pending edits, record the new base hashes, and log each unit's previous and new rawHash for clobber detection.

A conflict shows three versions to the user: the base Aquilla read, the file as it is now, and the Aquilla edit.

## Live sync and clobber protection

Aquilla never loses a change: it watches the project folder, takes Paratext changes live, and detects when Paratext overwrites an Aquilla edit from a stale in-memory copy.

The problem: Paratext holds open books in memory. When a user edits a book in Paratext, Paratext writes that book from memory. If Aquilla wrote the book after Paratext loaded it, the save silently reverts Aquilla's edits.

### Watch

- The Tauri app watches the project folder at directory level, debounced, and waits until a file's hash is the same on two reads.
- On a change it derives units and compares each one with what Aquilla last saw.
- A change whose blob hash equals Aquilla's own last write is an echo and is ignored.
- Changes from Send/Receive arrive the same way and follow the same rules.

### Classify each changed unit

For every write, Aquilla records each unit's previous and new `rawHash`. With that record, every unit in a changed file falls into one case.

| Case | Test | Action |
| --- | --- | --- |
| Theirs only | File differs from last seen; Aquilla has no pending or applied edit on the unit | Accept silently; update the base |
| Stale revert (clobber) | Aquilla wrote `new`; the file now shows that unit's `previous` | Keep mine; prompt "Paratext reverted N of your edits" with mine preselected |
| Both changed | The file shows a third value and Aquilla has an edit on the unit | Prompt: mine or theirs |
| Mine pending | Aquilla has an unwritten edit; the file is unchanged at that unit | Nothing; write back as normal |

A deliberate revert in Paratext looks the same as a stale revert. It is rare, and the prompt lets the user take theirs.

### Resolve

- Per unit: Keep mine or Take theirs. Per book: Keep all mine or Take all theirs.
- Keep mine becomes a new pending edit whose base is theirs, so the normal write-back checks still apply.
- Every resolution is an event: base, mine, theirs, choice, user, time.

### Hold the book after a clobber

If Aquilla writes mine back while Paratext still holds the stale copy, the next Paratext save reverts it again. That is a loop.

- After a clobber, the book goes on hold. Resolutions queue as pending edits but are not written.
- The hold lifts when Paratext is not running, or when the user confirms the book is closed or reloaded in Paratext. The spike must show which of these actually clears Paratext's copy.
- The plugin route removes the hold: resolutions write through Paratext, so its memory stays current.

### History

- Every blob Aquilla observes or writes is stored content-addressed, in local app data and optionally R2. A new book version costs one blob; unchanged books cost nothing.
- Events: observed (snapshot hash, changed unit IDs), wrote (unit, previous, new), clobber detected, resolved.
- Any unit or whole book can go back to any observed version.

On the team side, Paratext history can show the Aquilla change, a revert, then the change again. That is noisy, but nothing is lost.

## Paratext registration

Aquilla can build the registration link itself from `Settings.xml`; the registry authorizes the user when they log in. The Register button in Paratext opens a URL carrying one token: Base64 without `=` padding, over a percent-encoded query string. The token has no signature or hash.

Decoded sample:

```
sn=TPP1&fn=Test%20Paratext%20Project%201&id=6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d&l=en&un=Ryder%20Wishart&t=Standard&p=
```

| Key | Sample value | Probable meaning | Probable source |
| --- | --- | --- | --- |
| `sn` | TPP1 | Project short name | `Settings.xml` `Name` |
| `fn` | Test Paratext Project 1 | Project full name | `Settings.xml` `FullName` |
| `id` | 6b5b95fb…2d3d | Project GUID, 40 hex characters | `Settings.xml` `Guid` |
| `l` | en | Interface or project language (not certain) | UI locale or `LanguageIsoCode` |
| `un` | Ryder Wishart | Paratext registration user name | Local Paratext registration |
| `t` | Standard | Project type | `TranslationInfo` |
| `p` | (empty) | Parent project for a daughter type such as a back translation (a guess) | `TranslationInfo` |

Decode a token (adds the missing padding):

```python
import base64, urllib.parse
s = "c249VFBQ..."
q = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()
print(urllib.parse.parse_qs(q, keep_blank_values=True))
```

Build a token in Aquilla (draft; confirm the alphabet and escaping first):

```ts
type RegFields = { sn: string; fn: string; id: string; l: string; un: string; t: string; p?: string };

export function registrationToken(f: RegFields): string {
  const order = ["sn", "fn", "id", "l", "un", "t", "p"] as const;
  const query = order.map((k) => `${k}=${encodeURIComponent(f[k] ?? "")}`).join("&");
  const bytes = new TextEncoder().encode(query);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}
```

To confirm before shipping:

- The base URL the token is appended to.
- Standard Base64 (`+` `/`) or URL-safe (`-` `_`). The sample does not show which.
- Whether Paratext escapes `!'()*`, which `encodeURIComponent` leaves alone.
- What `l` means, and the exact format of `p` for a daughter project.

## Constraints

The main risk is two programs writing the same files, not Mercurial.

| Constraint | Design response |
| --- | --- |
| Paratext keeps open books in memory and can overwrite outside edits | Detect clobbers, keep the Aquilla change, and hold the book until Paratext drops its stale copy |
| `Settings.xml` sets encoding, file naming, versification, normalization and stylesheet | The filter reads it; version 1 supports UTF-8 projects only |
| `ProjectUserAccess.xml` limits who edits which books and chapters | Aquilla locks books the user cannot edit; Send/Receive may reject unauthorized changes |
| Extra files in the project folder may be committed by Send/Receive | Backups, temp files and locks live outside the folder |
| Licensed resources are encrypted | They cannot be a lane; the source lane comes from elsewhere |
| Paratext 9 users are mostly on Windows; Mac users often run it in a VM | Windows first |
| Paratext Live sessions edit in real time | Block writes during a Live session |
| Notes, term renderings and progress have their own merge rules | Read-only in version 1 |
| Edits made outside Paratext are not an official workflow | Treat Project History as the safety net; keep the SIL/UBS relationship informed |

## Routes and phases

Start with the direct file bridge in Tauri, add a Paratext 9 plugin so resolutions write through Paratext and the book hold goes away, and open the cloud-sync conversation with SIL/UBS now because it takes longest.

| Route | Writes through | Strength | Limit |
| --- | --- | --- | --- |
| Direct file bridge (Tauri) | USFM files on disk | Fast to build; no approval needed; [Bibledit does this on Windows](https://groups.google.com/g/bibledit-general/c/F9f6UNq29w0) | Stale Paratext copies can revert edits (caught and held); Aquilla owns all fidelity risk |
| Paratext 9 plugin | [Plugin API 2.0](https://github.com/ubsicap/paratext_demo_plugins/wiki) read/write calls | Paratext handles cache, permissions and history | Windows and .NET; needs a local channel to Aquilla |
| Paratext 10 Studio extension | [Platform.Bible](https://paranext.github.io/paranext-core) project data providers | Cross-platform; the long-term home | [Studio builds are still alpha](https://github.com/sillsdev/interlinearizer-extension/pull/208); few teams on it yet |
| Cloud sync, Scripture Forge model | ParatextData and the Send/Receive server ([how SF syncs](https://pr-36--sf-help-preview.netlify.app/syncing-with-paratext)) | Browser-only, no desktop app; fits the Biblica access need | Needs SIL/UBS approval and registry auth |

1. **Spike, one week.** Gate: every item in the test plan below has an answer.
2. **Direct bridge in Tauri.** Discover projects, derive units, join overlay, watch live, write back with clobber detection. Gate: byte-exact round trips on a set of real projects with zero unintended diffs.
3. **Plugin write path.** Gate: a Paratext 9 plugin can host or reach a local channel to Aquilla.
4. **Paratext 10 Studio extension.** Gate: enough partner teams move to Studio.

In parallel: start the SIL/UBS conversation about the cloud route.

## Spike test plan

Use a throwaway project, two registered users (A and B) on two machines, and record each result here.

- [ ] Edit a verse in the USFM file with Paratext closed. Open Paratext and confirm the change shows.
- [ ] Send/Receive as A. Confirm B receives the change and record the commit author.
- [ ] Edit the file while Paratext is open, once with the book closed and once with it open. Record what happens.
- [ ] Edit a book that A cannot edit. Record whether Send/Receive rejects it, and whether it says so.
- [ ] Make conflicting edits to one verse on both machines. Inspect the conflict note.
- [ ] Edit a verse that holds a footnote. Run `hg diff` and confirm only the intended bytes changed.
- [ ] Leave a stray file in the project folder. Check whether Send/Receive commits it.
- [ ] Compare overwrite-in-place against write-temp-then-rename. Check file attributes and how Paratext reacts.
- [ ] Confirm the 40-hex GUID in `Settings.xml` matches the registration `id`.
- [ ] Register a back-translation project. Decode its token and confirm `t` and `p`.
- [ ] Capture the registration base URL and the Base64 alphabet.
- [ ] Derive units from the same blob in the browser and in Tauri. Confirm identical IDs and hashes.

Clobber tests:

- [ ] Find when Paratext writes a book from memory: on each edit, on a timer, on Send/Receive, or on close.
- [ ] Write a book from outside while Paratext has it open, then edit a different verse in Paratext. Confirm the clobber, and that Aquilla classifies it as a stale revert.
- [ ] Find what clears Paratext's in-memory copy: closing the book window, closing the project, or only closing Paratext.
- [ ] Check whether a Paratext 9 plugin can report open books or force a reload.

## Open questions

- **Cloud mirror.** Do blobs go up to R2 (browser access, team collaboration) or stay on the device (privacy for partners like Biblica)?
- **Running Paratext.** Does Paratext 9 detect file changes made outside it while it runs? The spike answers this.
- **Registered user.** Where does Aquilla read which Paratext user is registered on the machine?
- **Normalization.** Which markers count as content in `textHash`, and which are ignored?
- **Carry-over.** How does overlay data move when a verse is split or a bridge is merged?
- **Filter versioning.** When a filter rule changes, which overlay rows need review?
- **Lane naming.** This doc assumes either lane can be file-backed. Confirm that matches how Aquilla names source and target.

* **Stale-revert prompt.** Should a stale revert keep mine automatically with only a notice, instead of a mine-or-theirs prompt? The prompt is safer; the notice is quieter.

## Spike results (2026-11-05, Paratext 9.5.110 under Wine on macOS)

Answered from the machine, not from the Paratext UI (control of the Wine window was not granted this session):

- **Registered user**: `%LOCALAPPDATA%\Paratext95\RegistrationInfo.xml` (`<Name>`, `<Email>`, `<Code>`). Under Wine: `<prefix>/drive_c/users/<user>/AppData/Local/Paratext9*/`.
- **Projects folder**: registry `HKLM\SOFTWARE\Wow6432Node\Paratext\8\Settings_Directory`; under Wine the same key is in `<prefix>/system.reg`. Here it is `C:\`, so the project is `drive_c/TPP1`.
- **GUID**: `Settings.xml` `<Guid>` is the 40-hex `id` in the registration token (confirmed, same value).
- **File numbering**: the canon list is 123 contiguous codes (`<BooksPresent>` bit order); file names skip 40 (MAT=41 … XXG=100) and then use A0 (FRT) … C3 (LAO). Verified against every TPP1 file name.
- **Bytes on disk**: BOM-less, CRLF, trailing space after an empty verse number is sometimes present (`\v 1 \r\n`) and sometimes not (`\v 2\r\n`). The splice preserves whichever it finds.
- **Round trips**: every unit of 106 real books (TPP1, an eBible NT, two TBTA projects) edited and restored byte-for-byte; 99 text-less TPP1 books skipped. Duplicate references exist in real data (DEU 5:4 twice in TAINIV); they get `@2`, `@3` IDs.
- **Live write**: Aquilla wrote MAT 1:2 in place while Paratext was running. Backup landed in app data (outside the project); only the intended line differed. Paratext's log shows no reaction to the external write (no watcher activity logged) — whether an open book re-reads it still needs the Paratext window.
- **Clobber**: restoring the pre-write bytes (what a stale Paratext save does) was caught by the folder watcher within seconds, classified as a stale revert, the book went on hold, "Keep mine" re-based the edit, releasing the hold let the write land again with an identical hash.
- **Not yet answered**: when Paratext writes a book from memory; what clears its in-memory copy; whether Send/Receive rejects unauthorised edits or commits stray files; the registration base URL and alphabet. These need two registered users and the Paratext window.

## Built (branch `ryder/paratext-bridge`)

- `src/lib/paratext-bridge/` — pure core: `units.ts` (derive units with byte spans, IDs, SHA-256 raw/text hashes), `write-back.ts` (splice end→start + proof), `classify.ts` (theirs-only / stale-revert / both-changed / mine-pending), `access.ts` (ProjectUserAccess.xml), `registration.ts`, `project.ts` + `book-codes.ts` (naming, BooksPresent), `store.ts` (local IndexedDB overlay: pending edits, write log, last-seen, own blobs, holds), `tauri.ts`, two hooks. 41 tests incl. golden IDs on a rich fixture.
- `src-tauri/src/paratext.rs` — discover (registry / Wine / defaults / user roots), read, hash, guarded in-place write with backup, folder watch with settle-check, running check. 6 Rust tests.
- UI: `/paratext` (projects on this computer) and `/paratext/book` (per-book editor, write, conflicts, hold), desktop-only entry button on the org projects page. No login required.
- Not built: server-side `source_snapshot` / `unit_overlay` tables and the file-backed lane in sync-worker (overlay is device-local for now), the Paratext 9 plugin route, non-UTF-8 projects, Windows registry path untested on Windows.
