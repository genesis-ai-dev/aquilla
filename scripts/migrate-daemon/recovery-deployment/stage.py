#!/usr/bin/env python3
"""Stage the audio-recovery overlay on an exact audited live runner. Never restart services.

Requires --base-app and a nonexistent --candidate-app. Refuses drift before copying
anything. Does not read env, queues, buckets, or database credentials.
"""
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
    parser.add_argument('--base-app', type=Path, required=True)
    parser.add_argument('--candidate-app', type=Path, required=True)
    args = parser.parse_args()
    base = args.base_app.resolve(strict=True)
    candidate = args.candidate_app.resolve()
    if candidate.exists() or base == candidate or base in candidate.parents:
        parser.error('Candidate must be a new directory outside the running app')
    here = Path(__file__).resolve().parent
    hashes = json.loads((here / 'hashes.json').read_text())
    for relative, expected in hashes.items():
        if (digest(base / relative) if (base / relative).exists() else None) != expected['before']:
            parser.error(f'Live runner drift at {relative}; re-integrate and qualify before staging')
    candidate.mkdir(parents=True)
    try:
        for name in ('src', 'scripts', 'packages', 'tests'):
            if (base / name).exists():
                shutil.copytree(base / name, candidate / name, ignore=shutil.ignore_patterns('node_modules', '.git'))
        for file in (*base.glob('tsconfig*.json'), base / 'package.json'):
            shutil.copy2(file, candidate / file.name)
        (candidate / 'node_modules').symlink_to(base / 'node_modules', target_is_directory=True)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(here / 'overlay.patch')], cwd=candidate, check=True)
        for relative, expected in hashes.items():
            if digest(candidate / relative) != expected['after']:
                raise RuntimeError(f'Candidate hash mismatch at {relative}')
        (candidate / 'audio-recovery-overlay.json').write_text(json.dumps({'base': str(base), 'files': hashes}, indent=2) + '\n')
    except BaseException:
        # This directory was created by this command and has never run.
        shutil.rmtree(candidate)
        raise
    print(f'Staged {candidate}. No services or production state changed; qualification and cutover are separate.')


if __name__ == '__main__':
    main()
