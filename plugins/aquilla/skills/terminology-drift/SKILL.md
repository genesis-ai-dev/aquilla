---
name: terminology-drift
description: Find key terms that an Aquilla project renders inconsistently and, if the user asks, prepare and save authorized corrections. Use for terminology checks, consistency reviews, or "fix the term X" requests.
---

# Terminology drift

Use this when the user asks whether key terms are consistent, or asks you to
fix a term. Finding drift is read-only. Fixing it stages a traceable changeset. OAuth connections use Act mode within
the organizations the user selected.

## Find

1. Call `read_term_consistency` with `onlyDrift: true` (add `fileId` if the
   user named a book or file).
2. For each concept, report: the source term, the approved renderings,
   `consistencyPercent`, and how many cells are flagged. Sort by flagged count.
3. Show at most ten concepts. Offer the rest on request.

## Fix (only when the user asks)

1. Pick the concept the user named. Flagged cells carry `cellId` (and a
   readable `cellLabel`) but not the file, so find the file first: run
   `read_term_consistency` again with each `fileId` from `read_quality`, or
   use `search_project` for the source term — its results carry `fileId` and
   `cellId`.
2. For each flagged cell, read its text with `read_content` for that `fileId`
   (page with `cursor`), and call `read_comments` with that `fileId` and
   `cellId`. If a reviewer already discussed the term there, follow the
   reviewer and tell the user.
3. Call `list_terms` and find the concept. Use its preferred rendering, and
   respect its notes and `matchOptions`.
4. Draft the corrected target text. Change only the term and the words that
   must agree with it. Keep everything else exactly as it is.
5. Call `prepare_translations` with all corrections in one changeset.
6. Show the user the returned summary, and an `approvalUrl` when provided.
   - If the prepared changeset uses ask mode: a person must open the link and approve. Stop here. Say the
     change is not saved yet.
   - If the prepared changeset uses act mode: call `confirm_changeset` for the corrections the user
     authorized. Respect host confirmation requirements. Saving does not
     establish human translation validation.
7. Only after `confirm_changeset` succeeds may you say the fix is saved.

## Do not

- Do not change an approved rendering itself. That is a termbase decision for
  a consultant, made in Aquilla.
- Do not "fix" a cell where the source term is used in a different sense.
  List it for a person instead.
