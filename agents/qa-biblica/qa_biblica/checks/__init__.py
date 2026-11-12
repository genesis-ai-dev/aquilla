"""One module per skill file. Each `run()` returns a `FindingSet`.

Pass 1 (mechanical) and Pass 2 (spelling) read only the corpus and the verified
baseline. Pass 3 (key terms) also reads `terms` and `terms/consistency`, because
Aquilla already runs that scan server-side and re-implementing it would produce a
second, disagreeing answer.
"""

from . import (
    capitalization_numbers,
    chapter_verse,
    characters_punctuation,
    key_terms_names,
    spelling_wordlist,
    text_integrity,
)

__all__ = [
    "capitalization_numbers",
    "chapter_verse",
    "characters_punctuation",
    "key_terms_names",
    "spelling_wordlist",
    "text_integrity",
]
