Kokoro 82M speaker samples (Apache 2.0, hexgrad/kokoro).

Each clip is the public-domain Aesop line hosted at
https://rewind.ai/voices/ as `/static/voice_previews/kokoro-{id}.wav`.
We vendor only the 28 American/British ids the in-browser kokoro-js
bundle can synthesize. Refresh with:

  npx tsx scripts/fetch-kokoro-previews.ts
