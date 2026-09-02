Kokoro 82M speaker samples (Apache 2.0, hexgrad/kokoro).

Each clip is Psalm 22:1 in that speaker's language. English uses the LSB.
Other languages use a published Bible for that language (RVR1960, Louis
Segond 1910, IRV Hindi 2019, Riveduta 1927, 口語訳 1955, ARA 1993,
新标点和合本). Japanese and Mandarin were phonemized with hexgrad/misaki.

We vendor all 54 speaker ids the kokoro-js 1.2.1 package ships (28
American/British + 26 multilingual). Encode a WAV pack with:

  npx tsx scripts/fetch-kokoro-previews.ts /path/to/wavs
