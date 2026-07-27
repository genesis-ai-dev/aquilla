# Generated IDML v2 conformance corpus

Every file in this directory is generated from source in
`scripts/generate-corpus.ts`. No Adobe sample, customer document, font, image,
or other third-party asset is included.

The generated corpus is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The package
itself remains private and `UNLICENSED`; CC0 applies only to these generated
fixtures so the same cases can legally be exercised in browser, Node, CI, and
Adobe validation infrastructure.

`valid/feature-rich.idml` is a compact synthetic UCF package covering mixed
character-style runs, hyperlinks, cross-references, custom and automatic text
variables, tabs, soft returns, empty content slots, XML entities, RTL, CJK,
Indic shaping sequences, decomposed Unicode, a long paragraph, nested tables,
footnotes, endnotes, notes, text on paths, anchored/threaded/master stories,
inline objects, two pages, layers, a programmatically generated valid PNG,
multiple stories, BOMs, and mixed XML line endings.

`valid/biblica-profile.idml` is a separately generated semantic-profile case.
It contains no Biblica-owned content or schema; the name means only that the
same lossless package is parsed through the engine's `biblica` profile.

`invalid/` contains deliberately corrupt or hostile packages. The
compression-bomb case expands to only 64 KiB so it is safe to commit and run;
tests lower the configured ratio limit to exercise the production rejection
path without carrying a dangerous payload.

`metadata/` contains generated legacy Codex, canonical v2, and stale-locator
records tied to the feature-rich package. The manifest records SHA-256 hashes,
expected operations, and typed failures.

Regenerate:

```sh
pnpm --dir packages/idml-roundtrip run fixtures:generate
```

Verify committed bytes are deterministic and current:

```sh
pnpm --dir packages/idml-roundtrip run fixtures:check
```

These fixtures prove package and engine conformance. They are not claimed to
be files saved by a particular InDesign release. Adobe open/preflight/save/
reopen/PDF validation remains the separate native-fidelity release gate.
