"""
One-shot backfill: stamp a `published_unix` into every existing build.json
under website/data/<dataset>/<slug>/ using the timestamp of the commit that
first added that file (git log --diff-filter=A).

Skips entries that already have a published_unix set. After stamping, the
matching dataset index.json is rebuilt so the gallery picks up the new order
on next page load.

Usage:
    python tools/backfill_published_unix.py
    python tools/backfill_published_unix.py --force   # overwrite existing values
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "website" / "data"
DATASETS = ("builds", "prefabs")


def first_commit_unix(path: Path) -> int | None:
    rel = path.relative_to(REPO).as_posix()
    try:
        out = subprocess.check_output(
            [
                "git", "log",
                "--diff-filter=A",
                "--follow",
                "--format=%at",
                "--", rel,
            ],
            cwd=REPO,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip().splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if not out:
        return None
    # The earliest add is the last line of `git log` output (chronological-rev).
    try:
        return int(out[-1])
    except ValueError:
        return None


def rebuild_index(dataset: str) -> None:
    root = DATA / dataset
    rows: list[tuple[int, str]] = []
    for p in root.iterdir():
        if not p.is_dir():
            continue
        cp = p / "build.json"
        if not cp.is_file():
            continue
        try:
            card = json.loads(cp.read_text(encoding="utf-8"))
            ts = int(card.get("published_unix") or 0)
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            ts = 0
        rows.append((ts, p.name))
    rows.sort(key=lambda r: (-r[0], r[1]))
    slugs = [name for _, name in rows]
    idx = root / "index.json"
    idx.write_text(json.dumps({"entries": slugs}, indent=2) + "\n",
                   encoding="utf-8")
    print(f"  rebuilt {idx.relative_to(REPO)} ({len(slugs)} entries)")


def main(argv: list[str]) -> int:
    force = "--force" in argv[1:]

    stamped = 0
    skipped = 0
    missing = 0

    for dataset in DATASETS:
        root = DATA / dataset
        if not root.is_dir():
            continue
        print(f"\n[{dataset}]")
        for slug_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            cp = slug_dir / "build.json"
            if not cp.is_file():
                continue
            try:
                card = json.loads(cp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                print(f"  [SKIP]   {slug_dir.name}: {exc}")
                continue
            if card.get("published_unix") and not force:
                skipped += 1
                continue
            ts = first_commit_unix(cp)
            if ts is None:
                print(f"  [NO-GIT] {slug_dir.name}: no commit history found")
                missing += 1
                continue
            card["published_unix"] = ts
            cp.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
            print(f"  [STAMP]  {slug_dir.name} -> {ts}")
            stamped += 1
        rebuild_index(dataset)

    print(
        f"\nDone. stamped={stamped} skipped(existing)={skipped} no-git={missing}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
