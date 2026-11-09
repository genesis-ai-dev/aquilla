#!/usr/bin/env python3
"""Prepare exact audited Worker bundle overlays locally. Does not upload or deploy."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-bundles', type=Path, required=True)
    parser.add_argument('--candidate-bundles', type=Path, required=True)
    args = parser.parse_args()
    base = args.base_bundles.resolve(strict=True)
    candidate = args.candidate_bundles.resolve()
    here = Path(__file__).resolve().parent
    hashes = json.loads((here / 'worker-hashes.json').read_text())
    if candidate.exists() or base == candidate or base in candidate.parents:
        parser.error('Candidate must be a new directory outside the input directory')
    for name, expected in hashes.items():
        if digest(base / name) != expected['before']:
            parser.error(f'Deployed bundle drift: {name}; re-integrate and qualify')
    candidate.mkdir(parents=True)
    try:
        for name in hashes:
            shutil.copy2(base / name, candidate / name)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(here / 'worker-overlay.patch')], cwd=candidate, check=True)
        for name, expected in hashes.items():
            if digest(candidate / name) != expected['after']:
                raise RuntimeError(f'Candidate hash mismatch: {name}')
    except BaseException:
        shutil.rmtree(candidate)
        raise
    print(f'Staged {candidate}. No uploads, deployments, bindings or production data changed.')


if __name__ == '__main__':
    main()
