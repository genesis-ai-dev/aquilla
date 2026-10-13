# QA walkthrough — lanes (AQU-1039)

A project has one shared source and one or more target lanes. "Same lane?" means the lane id. A language name is not a lane: two lanes can share a language, and a lane's `language` column may still be empty. Compare languages only through the shared normalizer. Do not treat a project-level language list as the thing you work in.

`legacy_tag` never changes. `''` is the former default lane and stays the bridge for events written before lanes had ids. Lane rows are archived, not deleted. Events are not rewritten.

Automated ground truth: `e2e/specs/projects/member-lane-scope.spec.ts`. This note is the walkthrough that still has to be done by hand. The ticket stays open until that pass.

## What you should see

1. Create a project with a source language and one target language. Import a file and translate a cell. That translation belongs to the default lane (`legacy_tag ''`).
2. The lane switcher is the target-language control in the editor column header. A maintainer sees it even when the project has only one lane, and can add a lane from it. Adding a lane creates a lane row. The settings tag list is not a second way to work.
3. Staff a contributor on the new lane only. On the project overview, open the Languages table (it appears once there is more than one lane), hover that lane, choose Actions, then Staff…. Pick someone already in the org, set their role to Contributor, and add them to that lane. A lead or maintainer cannot be limited to a lane; they see every lane.
4. Sign in as that contributor.
   - The switcher lists only the staffed lane. There is no Add lane.
   - Project settings and the cells read return that lane and the shared source. The other lane's translation is absent.
   - A commit or a validation aimed at the other lane is rejected. Translating and validating in the staffed lane succeeds.
5. Lane independence. The first lane still has its own translation and is not validated just because the second lane is. Switching back shows each lane's own text.
6. Shared source. Edit the source of a cell that already has a translation in each lane. Both lanes show the new source. Each lane's translation is marked stale on its own ("Source changed since last revision"). The translations do not copy across lanes.

## What not to do

Do not look for a Share panel to assign a lane. Do not remove a lane to hide it; archive it. Do not expect the switcher to disappear when a project has one lane. Do not identify a lane by the `language` column.
