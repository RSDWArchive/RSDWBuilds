"""
Process a manager replacement zip for an existing build/prefab.

The zip must contain exactly the existing dataset/slug layout:

    <dataset>/<slug>/build.json
    <dataset>/<slug>/<images...>
    <dataset>/<slug>/<download file>

Validation happens in a temporary folder before the existing entry is replaced.
Git history preserves prior files, so no separate data backup is committed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

from process_submissions import REPO, DATA, validate_card, safe_members, detect_layout

STAGING = REPO / "staging" / "management"
PROCESSED_ROOT = STAGING / "replacements" / "_processed"
TMP_ROOT = STAGING / "_tmp"


def extract_replacement(zip_path: Path, dataset: str, slug: str) -> Path:
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    tmp_parent = TMP_ROOT / stamp
    tmp_target = tmp_parent / dataset / slug
    if tmp_parent.exists():
        shutil.rmtree(tmp_parent)
    tmp_target.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as zf:
        for info in safe_members(zf):
            if info.is_dir():
                continue
            rel = Path(info.filename.replace("\\", "/")).relative_to(Path(dataset) / slug)
            out = tmp_target / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    return tmp_target


def archive_zip(zip_path: Path) -> Path:
    batch_root = PROCESSED_ROOT / datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    batch_root.mkdir(parents=True, exist_ok=True)
    dest = batch_root / zip_path.name
    n = 2
    while dest.exists():
        dest = batch_root / f"{zip_path.stem} ({n}){zip_path.suffix}"
        n += 1
    shutil.move(str(zip_path), str(dest))
    return dest


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, help="Replacement zip path")
    parser.add_argument("--dataset", required=True, choices=("builds", "prefabs"))
    parser.add_argument("--slug", required=True)
    args = parser.parse_args(argv[1:])

    zip_path = (REPO / args.zip).resolve()
    if not zip_path.is_file():
        print(f"replacement zip not found: {zip_path}", file=sys.stderr)
        return 2
    if not zip_path.is_relative_to(REPO / "staging" / "management" / "replacements"):
        print("replacement zip must live under staging/management/replacements", file=sys.stderr)
        return 2

    target = DATA / args.dataset / args.slug
    if not target.is_dir():
        print(f"target entry does not exist: {target.relative_to(REPO)}", file=sys.stderr)
        return 2

    with zipfile.ZipFile(zip_path) as zf:
        members = safe_members(zf)
    dataset, slug = detect_layout(members)
    if dataset != args.dataset or slug != args.slug:
        print(
            f"zip layout {dataset}/{slug} does not match requested {args.dataset}/{args.slug}",
            file=sys.stderr,
        )
        return 2

    old_card_path = target / "build.json"
    old_published = None
    if old_card_path.is_file():
        try:
            old_published = json.loads(old_card_path.read_text(encoding="utf-8")).get("published_unix")
        except (json.JSONDecodeError, OSError):
            old_published = None

    tmp_target = extract_replacement(zip_path, dataset, slug)
    errors = validate_card(tmp_target)
    if errors:
        print(f"replacement invalid for {dataset}/{slug}")
        for err in errors:
            print(f"  - {err}")
        shutil.rmtree(tmp_target.parents[1], ignore_errors=True)
        return 1

    card_path = tmp_target / "build.json"
    card = json.loads(card_path.read_text(encoding="utf-8"))
    if old_published:
        card["published_unix"] = old_published
    else:
        card.setdefault("published_unix", int(time.time()))
    card["updated_unix"] = int(time.time())
    card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

    shutil.rmtree(target)
    shutil.move(str(tmp_target), str(target))
    shutil.rmtree(tmp_target.parents[1], ignore_errors=True)
    archived = archive_zip(zip_path)
    print(f"replaced {target.relative_to(REPO)}")
    print(f"archived {archived.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
