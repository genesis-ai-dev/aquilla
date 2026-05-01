# MMS TTS R2 Hosting

The app can use two MMS sources:

- Default: public `Xenova/mms-tts-*` browser-ready repos. This set is small.
- Hosted: converted MMS ONNX repos from our own object storage.

Configure hosted MMS at build time:

```bash
VITE_MMS_MODEL_REMOTE_HOST=https://models.example.com
VITE_MMS_MODEL_REMOTE_PATH_TEMPLATE={model}/resolve/{revision}/
VITE_MMS_MODEL_REPO_PREFIX=facebook/mms-tts-
```

With that configuration, language code `ita` loads:

```text
https://models.example.com/facebook/mms-tts-ita/resolve/main/config.json
https://models.example.com/facebook/mms-tts-ita/resolve/main/tokenizer.json
https://models.example.com/facebook/mms-tts-ita/resolve/main/onnx/model.onnx
```

The bucket must be public for reads and must allow CORS from the app origin:

```text
GET, HEAD
Access-Control-Allow-Origin: https://<app-host>
Access-Control-Allow-Headers: range, content-type
```

Recommended object layout is to mirror the Hugging Face resolve layout above. It lets Transformers.js keep using normal model IDs while only changing `env.remoteHost`.

## Conversion Pipeline

Each MMS language is a separate VITS checkpoint, e.g. `facebook/mms-tts-ita`. Convert each checkpoint to the Transformers.js ONNX layout, then upload the complete output folder to R2.

Baseline per-model command from a checkout of `huggingface/transformers.js`:

```bash
python -m scripts.convert --quantize --model_id facebook/mms-tts-ita
```

Expected output shape:

```text
models/facebook/mms-tts-ita/
  config.json
  tokenizer.json
  tokenizer_config.json
  vocab.json
  special_tokens_map.json
  onnx/
    model.onnx
    model_quantized.onnx
```

This repo includes a resumable helper for conversion and upload:

```bash
TRANSFORMERS_JS_DIR=../transformers.js \
MMS_R2_BUCKET=codex-mms-models \
npm run mms:r2:publish -- --codes=eng,spa,ita
```

For a small validation batch from the full Hugging Face model list:

```bash
TRANSFORMERS_JS_DIR=../transformers.js \
MMS_R2_BUCKET=codex-mms-models \
npm run mms:r2:publish -- --limit=5
```

When the first few languages work end to end in the browser, remove `--limit` and let the batch continue. The script writes `.cache/mms-r2/state.json`, so it can resume after a failed conversion or upload. It stores objects under:

```text
<bucket>/<optional-prefix>/facebook/mms-tts-ita/resolve/main/...
```

If conversion and upload are handled separately, use:

```bash
npm run mms:r2:publish -- --skip-upload --codes=ita
npm run mms:r2:publish -- --skip-convert --converted-dir=../transformers.js/models --codes=ita
```

## Caveats

- MMS-TTS is CC-BY-NC 4.0. Commercial use needs legal review.
- Total storage is large. At roughly 100-200 MB per language, all 1100+ models can land in the 100-250 GB range before variants.
- Not every code users expect is necessarily a TTS checkpoint. Build the batch from the actual `facebook/mms-tts-*` repos, not from ASR language coverage.
