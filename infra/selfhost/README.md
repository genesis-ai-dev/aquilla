# Self-hosted Omnilingual ASR

`omni_asr_server.py` serves the same API as the Modal web app in
`infra/modal/omni_asr.py`, on hardware you run yourself. The models stay
loaded, so there is no cold start and no GPU queue. The auth-worker tries this
server first (`OMNI_ASR_PRIMARY_URL`) and falls back to Modal on a network
error, a timeout or a 5xx. It never falls back on a 4xx.

| Setting | Default | Notes |
| --- | --- | --- |
| `OMNI_SHARED_SECRET` | required | The auth-worker's `OMNI_SHARED_SECRET`. |
| `OMNI_CTC_MODEL` | `omniASR_CTC_1B` | `omniASR_CTC_300M` runs one forward pass for text and timings. |
| `OMNI_CTC_DEVICE` | `cuda:0`, else `cpu` | |
| `OMNI_ZS_DEVICE` | `cuda:1` with 2+ GPUs, else `off` | `off`: ZS answers 503, so the worker uses Modal. |
| `OMNI_CTC_QUANTIZE` | unset | `int8`: dynamic int8 Linear layers. CPU only. |
| `OMNI_EXAMPLE_HOSTS` | unset | Allow-list for ZS example URLs, as on Modal. |

The server reports the real device name as `gpu` (for example
`NVIDIA GeForce RTX 4090`), or `self-hosted-cpu` on CPU. Billing prices those
names in `db/shared/omni-asr-cost.ts`. If you add a new card, add its name
there too: an unknown name bills at the highest rate.

Memory, measured on 2× RTX 4090 (2026-10-27): CTC 1B and the 300M aligner
peak at 2.6 GiB on GPU 0. ZS 7B peaks at 15.1 GiB on GPU 1 (16.9 GB used on
the card), so it fits on a 24 GB card. A warm CTC call on a 5 s clip takes
0.09 s end to end; ZS takes 1.3–2.2 s. First start: CTC loads in about 4 min
and ZS in about 11 min, most of it the weight download.

## Install (Ubuntu / Pop!_OS with an NVIDIA driver)

```bash
sudo apt install -y ffmpeg libsndfile1 python3.11 python3.11-venv
sudo mkdir -p /opt/aquilla-omni /var/cache/aquilla-omni && sudo chown "$USER" /opt/aquilla-omni /var/cache/aquilla-omni
# Copy the two infra folders the server needs (from a checkout of this repo):
rsync -a infra/modal infra/selfhost <box>:/opt/aquilla-omni/infra/
cd /opt/aquilla-omni && python3.11 -m venv .venv && .venv/bin/pip install -r infra/selfhost/requirements.txt
printf 'OMNI_SHARED_SECRET=%s\n' '<the worker secret>' | sudo tee /etc/aquilla-omni.env >/dev/null
sudo chmod 600 /etc/aquilla-omni.env
sudo cp infra/selfhost/omni-asr@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now "omni-asr@$USER"
journalctl -u "omni-asr@$USER" -f     # wait for "[zs] loaded"
curl -s localhost:8088/healthz       # {"ok":true,"models":["ctc","zs"]}
```

Without sudo, run it as a systemd **user** service instead (needs
`loginctl enable-linger $USER` once, so it runs while nobody is logged in).
Put the venv and code in `~/aquilla-omni`, the secret in
`~/.config/aquilla-omni.env` (mode 600), and a copy of the unit at
`~/.config/systemd/user/omni-asr.service` with `%h/...` paths in place of
`/opt/...` and `/etc/...` and no `User=` line. Then
`systemctl --user enable --now omni-asr`.

The first start downloads about 32 GB of weights into
`/var/cache/aquilla-omni/fairseq2`. Later starts load from disk.

## Public HTTPS with Cloudflare Tunnel

The server listens on `127.0.0.1:8088` only. A Cloudflare Tunnel gives it a
public HTTPS hostname without opening a port on the router. The
`X-Omni-Secret` header is the access control, as on Modal.

```bash
# Install cloudflared: https://pkg.cloudflare.com (apt repository)
cloudflared tunnel login                     # pick the zone, e.g. aquilla.app
cloudflared tunnel create aquilla-omni-asr
cloudflared tunnel route dns aquilla-omni-asr omni-asr.aquilla.app
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml >/dev/null <<YML
tunnel: aquilla-omni-asr
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: omni-asr.aquilla.app
    service: http://127.0.0.1:8088
    originRequest:
      connectTimeout: 5s
  - service: http_status:404
YML
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo cloudflared service install && sudo systemctl enable --now cloudflared
curl -s https://omni-asr.aquilla.app/healthz
```

When the box or the server is down, Cloudflare answers 502 or 530. The
worker treats those as 5xx and uses Modal.

Then point the worker at it (see `docs/DEPLOYMENT-ENVIRONMENTS.md`):
set `OMNI_ASR_PRIMARY_URL = "https://omni-asr.aquilla.app"` in the
environment's `[vars]` block in `auth-worker/wrangler.toml`. The secret stays
`OMNI_SHARED_SECRET`.

## CPU-only host

On a host with no GPU, set `OMNI_CTC_DEVICE=cpu` (the default without CUDA).
ZS is off, so ZS requests go to Modal. See
`docs/benchmarks/omni-asr-cpu.md` for CPU speed and accuracy.
