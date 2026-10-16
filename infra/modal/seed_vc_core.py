"""
Seed-VC conversion core shared by the Modal deployment (`seed_vc.py`) and the
local Apple-silicon server (`seed_vc_local.py`), so the two cannot drift.

It needs a checkout of the upstream repo at the commit pinned in `seed_vc.py`:
upstream uses relative imports (`from modules...`) and relative config paths,
so the repo must be importable and the cwd must be the repo root while loading.
Upstream's `inference.py` picks the device itself (cuda → mps → cpu).
"""

import contextlib
import os
import sys
import tempfile
import types


class SeedVCEngine:
    """Speech (non-F0) model loaded once, converted per call."""

    def __init__(self, seed_vc_dir: str, fp16: bool):
        sys.path.insert(0, seed_vc_dir)
        os.chdir(seed_vc_dir)

        import inference as svc  # upstream module; we reuse its helpers + loader

        # Mirror argparse defaults for the non-F0 speech model.
        args = types.SimpleNamespace(
            f0_condition=False,
            checkpoint=None,
            config=None,
            fp16=fp16,
        )
        self.svc = svc
        # load_models() also sets the module global `svc.fp16` used during inference.
        self.models = svc.load_models(args)

        if svc.device.type == "mps":
            # BigVGAN's alias-free upsampler is a grouped conv_transpose1d with
            # more than 65536 output channels, which MPS refuses outright (not
            # a missing op, so PYTORCH_ENABLE_MPS_FALLBACK does not help). Run
            # only the vocoder on CPU; everything upstream of it stays on MPS.
            model, semantic_fn, f0_fn, vocoder, campplus_model, mel_fn, mel_fn_args = self.models
            vocoder = vocoder.to("cpu")
            self.models = (
                model, semantic_fn, f0_fn, lambda mel: vocoder(mel.cpu()),
                campplus_model, mel_fn, mel_fn_args,
            )

    @property
    def device(self) -> str:
        return str(self.svc.device)

    def _run(self, source_path, reference_path, diffusion_steps, length_adjust, inference_cfg_rate):
        """Faithful reproduction of upstream `main(args)` for the non-F0 model,
        minus the load step (done once in __init__) and the F0 branch (model is
        pinned to f0_condition=False). Returns (wav_tensor, sample_rate)."""
        import librosa
        import numpy as np
        import torch
        import torchaudio

        svc = self.svc
        device = svc.device
        model, semantic_fn, f0_fn, vocoder_fn, campplus_model, mel_fn, mel_fn_args = self.models

        with torch.no_grad():
            sr = mel_fn_args["sampling_rate"]
            source_audio = librosa.load(source_path, sr=sr)[0]
            ref_audio = librosa.load(reference_path, sr=sr)[0]

            # Non-F0 speech-model constants (upstream: sr=22050, hop=256 when no F0).
            sr = 22050
            hop_length = 256
            max_context_window = sr // hop_length * 30
            overlap_frame_len = 16
            overlap_wave_len = overlap_frame_len * hop_length

            source_audio = torch.tensor(source_audio).unsqueeze(0).float().to(device)
            ref_audio = torch.tensor(ref_audio[: sr * 25]).unsqueeze(0).float().to(device)

            # Semantic tokens for the source. Whisper handles <=30s in one pass;
            # longer source is chunked with a 5s overlap and stitched.
            converted_waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
            if converted_waves_16k.size(-1) <= 16000 * 30:
                S_alt = semantic_fn(converted_waves_16k)
            else:
                overlapping_time = 5
                S_alt_list = []
                buffer = None
                traversed_time = 0
                while traversed_time < converted_waves_16k.size(-1):
                    if buffer is None:
                        chunk = converted_waves_16k[:, traversed_time : traversed_time + 16000 * 30]
                    else:
                        chunk = torch.cat(
                            [buffer, converted_waves_16k[:, traversed_time : traversed_time + 16000 * (30 - overlapping_time)]],
                            dim=-1,
                        )
                    S_alt = semantic_fn(chunk)
                    if traversed_time == 0:
                        S_alt_list.append(S_alt)
                    else:
                        S_alt_list.append(S_alt[:, 50 * overlapping_time :])
                    buffer = chunk[:, -16000 * overlapping_time :]
                    traversed_time += 30 * 16000 if traversed_time == 0 else chunk.size(-1) - 16000 * overlapping_time
                S_alt = torch.cat(S_alt_list, dim=1)

            ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
            S_ori = semantic_fn(ori_waves_16k)

            mel = mel_fn(source_audio.to(device).float())
            mel2 = mel_fn(ref_audio.to(device).float())

            target_lengths = torch.LongTensor([int(mel.size(2) * length_adjust)]).to(mel.device)
            target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

            feat2 = torchaudio.compliance.kaldi.fbank(
                ori_waves_16k, num_mel_bins=80, dither=0, sample_frequency=16000
            )
            feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
            style2 = campplus_model(feat2.unsqueeze(0))

            # F0 is disabled for the speech model.
            shifted_f0_alt = None
            F0_ori = None

            cond, _, _, _, _ = model.length_regulator(
                S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt
            )
            prompt_condition, _, _, _, _ = model.length_regulator(
                S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori
            )

            # Generate chunk-by-chunk with crossfade at the overlaps.
            max_source_window = max_context_window - mel2.size(2)
            processed_frames = 0
            generated_wave_chunks = []
            previous_chunk = None
            while processed_frames < cond.size(1):
                chunk_cond = cond[:, processed_frames : processed_frames + max_source_window]
                is_last_chunk = processed_frames + max_source_window >= cond.size(1)
                cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
                # Autocast only when fp16 is on: some torch builds reject an MPS
                # autocast region even when disabled, and fp32 needs none.
                autocast = (
                    torch.autocast(device_type=device.type, dtype=torch.float16)
                    if svc.fp16
                    else contextlib.nullcontext()
                )
                with autocast:
                    vc_target = model.cfm.inference(
                        cat_condition,
                        torch.LongTensor([cat_condition.size(1)]).to(mel2.device),
                        mel2,
                        style2,
                        None,
                        diffusion_steps,
                        inference_cfg_rate=inference_cfg_rate,
                    )
                    vc_target = vc_target[:, :, mel2.size(-1) :]
                vc_wave = vocoder_fn(vc_target.float()).squeeze()[None, :]
                if processed_frames == 0:
                    if is_last_chunk:
                        generated_wave_chunks.append(vc_wave[0].cpu().numpy())
                        break
                    generated_wave_chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
                    previous_chunk = vc_wave[0, -overlap_wave_len:]
                    processed_frames += vc_target.size(2) - overlap_frame_len
                elif is_last_chunk:
                    output_wave = svc.crossfade(
                        previous_chunk.cpu().numpy(), vc_wave[0].cpu().numpy(), overlap_wave_len
                    )
                    generated_wave_chunks.append(output_wave)
                    processed_frames += vc_target.size(2) - overlap_frame_len
                    break
                else:
                    output_wave = svc.crossfade(
                        previous_chunk.cpu().numpy(),
                        vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                        overlap_wave_len,
                    )
                    generated_wave_chunks.append(output_wave)
                    previous_chunk = vc_wave[0, -overlap_wave_len:]
                    processed_frames += vc_target.size(2) - overlap_frame_len

            vc_wave = torch.tensor(np.concatenate(generated_wave_chunks))[None, :].float()
            return vc_wave, sr

    def convert(
        self,
        source_bytes: bytes,
        reference_bytes: bytes,
        diffusion_steps: int = 10,     # 4-10 fastest, 25 default, 30-50 best quality
        length_adjust: float = 1.0,    # keep at 1.0 so duration is preserved
        inference_cfg_rate: float = 0.7,
    ) -> bytes:
        """Re-voice `source_bytes` into the timbre of `reference_bytes`; returns WAV bytes."""
        import torchaudio

        work = tempfile.mkdtemp()
        src = os.path.join(work, "source.wav")
        ref = os.path.join(work, "reference.wav")
        out = os.path.join(work, "converted.wav")
        with open(src, "wb") as f:
            f.write(source_bytes)
        with open(ref, "wb") as f:
            f.write(reference_bytes)

        vc_wave, sr = self._run(src, ref, diffusion_steps, length_adjust, inference_cfg_rate)
        torchaudio.save(out, vc_wave.cpu(), sr)
        with open(out, "rb") as f:
            return f.read()
