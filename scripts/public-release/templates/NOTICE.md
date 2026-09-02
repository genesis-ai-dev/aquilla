# NOTICE

This product is licensed under the GNU Affero General Public License v3.0
(see `LICENSE`). It includes, references, or interoperates with third-party
material under separate terms, acknowledged below.

## Bundled third-party content

### Scripture test fixtures — unfoldingWord® (CC BY-SA 4.0)

The USFM fixtures under `src/lib/parsers/__fixtures__/` are derived from
unfoldingWord translations:

- `uhb-exo-1.usfm` — unfoldingWord® Hebrew Bible (UHB)
- `ult-tit-1.usfm`, `ult-psa-1.usfm` — unfoldingWord® Literal Text (ULT)

© unfoldingWord. Licensed under Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/
"unfoldingWord" is a trademark of unfoldingWord and is used for identification
only; this project is not endorsed by or affiliated with unfoldingWord.

### Versification reference — eBible / vref

`src/lib/parsers/ebible/vref.txt` is the standard verse-reference list used
across open Bible-technology projects.

## Referenced services (not bundled — accessed at runtime)

This application can import content from third-party services. That content is
fetched at the user's direction and remains under its own license. The
integration code is original to this project; the data is not.

- **Free Use Bible API** (`bible.helloao.org`) — AO Lab.
- **MACULA** Hebrew/Greek linguistic data — Clear Bible, CC BY 4.0.
- **Semantic Dictionary of Biblical Hebrew (SDBH)** — United Bible Societies /
  MARBLE. Accessed under UBS terms; no SDBH data is distributed here.
- **Door43 Content Service (DCS) / Gitea catalog** — unfoldingWord. Catalog
  client only; no catalog payloads are distributed here.
- **Open Bible Stories (OBS)** — unfoldingWord, CC BY-SA 4.0 (imported at
  runtime).

## Models referenced by the Modal services

The scripts under `infra/modal/` are generic integration stubs. They do not
bundle model weights or upstream model code. To run real inference you must
supply your own deployment of the referenced models under their own licenses
(e.g. Seed-VC, OmniVoice, and `pyannote/speaker-diarization`, which is a gated
Hugging Face model requiring acceptance of its conditions).

## Trademarks

"Acme App" and its assets under `src/branding/assets/acme/` are placeholder
example branding for demonstrating the multi-brand system, and are not a real
product.
