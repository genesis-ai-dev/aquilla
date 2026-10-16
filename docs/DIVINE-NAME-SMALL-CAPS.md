# The divine name (YHWH) and its small caps — translator guidance

**Status: DRAFT (AQU-1959).** The partner-facing wording below still needs Joel's and
Cleiton's review before it goes to BGP or any other publisher team. The *behavior* it
describes is implemented and covered by tests; only the copy is provisional.

---

## What translators do

**Nothing new.** You do not mark the divine name yourself, and there is no button for it.

The source file already marks it. In USFM that is the `\nd …\nd*` "name of deity" marker;
in a publisher's InDesign package it is a character style, usually named `nd`, that renders
small caps. Aquilla imports that marked span as **its own slot** in the cell — a protected
run you can type inside but not dissolve.

So the procedure is:

1. Find the slot holding the source's divine name. It is the one the source rendered as
   **Lᴏʀᴅ** in small caps.
2. Replace the words inside it with your language's rendering of the divine name — only
   those words. Leave the slot itself alone.
3. Translate the surrounding prose in the surrounding slots as usual.

What you must **not** do is delete the marked run and retype the whole verse as one flat
piece of text. Aquilla refuses that edit rather than accepting it and quietly losing the
formatting, so you will see the commit rejected instead of discovering plain text in the
printed proof months later.

## What export does

- **USFM export** keeps the `\nd …\nd*` marker around whatever you typed inside it.
- **InDesign/IDML export** keeps the small-caps character style around whatever you typed
  inside it. The style travels with the run, so it still renders small caps in the output
  package even when the package did not previously define that style.
- **Bible swap** (replacing a study edition's English Bible text with a translated Bible)
  fills each marked run from the translated Bible's own correspondingly marked run, in
  order. The small caps come from the study package's style; the words come from your
  translation.

If the two packages disagree — your translation marks the divine name twice in a verse where
the English marks it once, or does not mark it at all — the swap **leaves those runs alone**
rather than guessing which words belong in small caps, and the verse is listed in the swap
report as unmatched. Fix it by marking the divine name in the translated Bible the same
number of times the source does, then re-run the swap.

## Projects finished in Codex

**Open question — needs a data check before this goes out.** Codex-era projects were
imported before the marked-run contract existed, so whether their divine-name runs still
carry the marker has to be answered from the data, per project, not assumed. The check is a
count of cells whose source carries the divine-name marker against the count whose target
still has it. Until that number exists for at least one real BGP project, this section
should not be sent to the partner.

See AQU-1959 for the open item.
