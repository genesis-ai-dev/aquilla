# Preferences survive a reload

Smoke twin: `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.

## Steps

1. Open `/preferences`.
2. Note the state of the **Share usage data** switch.
3. Click the switch. It flips.
4. Reload the page.
5. Read the switch again.
6. Click it once more to put it back the way you found it.

## Expected end state

- After step 4 the switch shows the flipped state, not the original.
- After step 6 it shows the original state.

## Counts as a failure

- The switch does not flip on click.
- The reload shows the original state.

## Notes for the agent

The control is a `switch` role named **Share usage data**. Read `checked` from the snapshot; do not rely on the screenshot colour.
