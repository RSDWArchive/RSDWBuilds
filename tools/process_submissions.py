"""
Process community submission .zip files dropped into website/staging/incoming/.

Each zip must contain a single top-level layout (this is exactly what the
/submit/ page produces):

    <dataset>/<slug>/build.json
    <dataset>/<slug>/<images...>
    <dataset>/<slug>/<download file>

where <dataset> is one of {"builds", "prefabs"}.

For every zip:
  1. Inspect members (reject zip-slip paths, mixed prefixes, unknown dataset).
  2. Extract straight into website/data/<dataset>/<slug>/.
  3. Validate the resulting build.json + referenced files.
  4. On success: rebuild website/data/<dataset>/index.json, then archive the
     zip into staging/incoming/_processed/<timestamp>/.
  5. On failure: delete the extracted folder, leave the zip in incoming/ so
     the submitter or maintainer can fix and retry.

Usage (no flags):
    python tools/process_submissions.py
"""
from __future__ import annotations

import datetime
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEBSITE = REPO / "website"
DATA = WEBSITE / "data"
INCOMING = WEBSITE / "staging" / "incoming"
PROCESSED_ROOT = INCOMING / "_processed"

VALID_DATASETS = {"builds", "prefabs"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]*$")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
REQUIRED_FIELDS = ("name", "description", "authors", "image", "download")


# --- zip inspection ---------------------------------------------------------

def safe_members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    members: list[zipfile.ZipInfo] = []
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or ".." in Path(name).parts:
            raise ValueError(f"unsafe path in zip: {info.filename!r}")
        members.append(info)
    return members


def detect_layout(members: list[zipfile.ZipInfo]) -> tuple[str, str]:
    files = [m for m in members if not m.is_dir()]
    if not files:
        raise ValueError("zip contains no files")
    first = Path(files[0].filename.replace("\\", "/")).parts
    if len(first) < 3:
        raise ValueError(
            "zip layout must be <dataset>/<slug>/<file>; got "
            + files[0].filename
        )
    dataset, slug = first[0], first[1]
    if dataset not in VALID_DATASETS:
        raise ValueError(
            f"unknown dataset {dataset!r}; expected one of {sorted(VALID_DATASETS)}"
        )
    if not SLUG_RE.match(slug):
        raise ValueError(
            f"invalid slug {slug!r}: must be lowercase alphanumeric, '-' or '_'"
        )
    for f in files:
        parts = Path(f.filename.replace("\\", "/")).parts
        if len(parts) < 3 or parts[0] != dataset or parts[1] != slug:
            raise ValueError(
                f"zip contains mixed prefixes: {parts[0]}/{parts[1]} != {dataset}/{slug}"
            )
    return dataset, slug


# --- extraction + validation -----------------------------------------------

def extract_to_data(
    zip_path: Path, dataset: str, slug: str, members: list[zipfile.ZipInfo]
) -> Path:
    target = DATA / dataset / slug
    if target.exists():
        raise FileExistsError(
            f"already published: {target.relative_to(REPO)} "
            "(rename your slug or remove the existing entry first)"
        )
    target.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(zip_path) as zf:
        for info in members:
            if info.is_dir():
                continue
            rel = Path(info.filename.replace("\\", "/")).relative_to(
                Path(dataset) / slug
            )
            if not rel.parts:
                continue
            out = target / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    return target


def validate_card(folder: Path) -> list[str]:
    errors: list[str] = []
    card_path = folder / "build.json"
    if not card_path.is_file():
        return ["missing build.json"]

    try:
        card = json.loads(card_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return [f"build.json invalid JSON: {exc}"]
    if not isinstance(card, dict):
        return ["build.json must be a JSON object"]

    for field in REQUIRED_FIELDS:
        if field not in card:
            errors.append(f"missing required field '{field}'")

    name = card.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip()):
        errors.append("'name' must be a non-empty string")

    desc = card.get("description")
    if desc is not None and not isinstance(desc, str):
        errors.append("'description' must be a string")

    authors = card.get("authors")
    if authors is not None:
        if not isinstance(authors, list) or not authors:
            errors.append("'authors' must be a non-empty list")
        elif not all(isinstance(a, str) and a.strip() for a in authors):
            errors.append("'authors' entries must be non-empty strings")

    tags = card.get("tags", [])
    if tags and (
        not isinstance(tags, list)
        or not all(isinstance(t, str) and t.strip() for t in tags)
    ):
        errors.append("'tags' must be a list of non-empty strings")

    image = card.get("image")
    images = card.get("images")
    img_list: list[str] = []
    if isinstance(image, str) and image:
        img_list.append(image)
    if isinstance(images, list):
        for x in images:
            if isinstance(x, str) and x and x not in img_list:
                img_list.append(x)
    if not img_list:
        errors.append("no images listed (need 'image' or 'images')")
    for img in img_list:
        p = folder / img
        if not p.is_file():
            errors.append(f"image not found: {img}")
        elif p.suffix.lower() not in IMG_EXTS:
            errors.append(f"image extension not allowed: {img}")

    download = card.get("download")
    if isinstance(download, str) and download:
        dl = folder / download
        if not dl.is_file():
            errors.append(f"download file not found: {download}")
        elif dl.suffix.lower() == ".json":
            try:
                json.loads(dl.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                errors.append(f"download.json invalid JSON: {exc}")

    referenced = {"build.json"} | set(img_list)
    if isinstance(download, str):
        referenced.add(download)
    extras = [
        p.name for p in folder.iterdir()
        if p.is_file() and p.name not in referenced
    ]
    if extras:
        errors.append(f"unreferenced files in folder: {sorted(extras)}")

    return errors


def rebuild_index(dataset: str) -> Path:
    root = DATA / dataset
    root.mkdir(parents=True, exist_ok=True)
    slugs = sorted(
        p.name for p in root.iterdir()
        if p.is_dir() and (p / "build.json").is_file()
    )
    idx = root / "index.json"
    idx.write_text(
        json.dumps({"entries": slugs}, indent=2) + "\n", encoding="utf-8"
    )
    return idx


def archive_zip(zip_path: Path, batch_root: Path) -> Path:
    batch_root.mkdir(parents=True, exist_ok=True)
    dest = batch_root / zip_path.name
    n = 2
    while dest.exists():
        dest = batch_root / f"{zip_path.stem} ({n}){zip_path.suffix}"
        n += 1
    shutil.move(str(zip_path), str(dest))
    return dest


# --- entry point ------------------------------------------------------------

def main() -> int:
    if not INCOMING.is_dir():
        print(f"no incoming dir at {INCOMING}; nothing to do")
        return 0

    zips = sorted(
        p for p in INCOMING.iterdir()
        if p.is_file() and p.suffix.lower() == ".zip"
    )
    if not zips:
        print(f"no .zip files in {INCOMING.relative_to(REPO)}")
        return 0

    print(f"Processing {len(zips)} zip(s) from {INCOMING.relative_to(REPO)}\n")

    batch_root = (
        PROCESSED_ROOT
        / datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    published: dict[str, list[str]] = {}
    failed = 0

    for zp in zips:
        try:
            with zipfile.ZipFile(zp) as zf:
                members = safe_members(zf)
            dataset, slug = detect_layout(members)
        except (zipfile.BadZipFile, ValueError) as exc:
            print(f"  [FAIL]      {zp.name}: {exc}")
            failed += 1
            continue

        try:
            target = extract_to_data(zp, dataset, slug, members)
        except (FileExistsError, OSError) as exc:
            print(f"  [FAIL]      {zp.name}: {exc}")
            failed += 1
            continue

        errors = validate_card(target)
        if errors:
            print(f"  [INVALID]   {zp.name} -> {dataset}/{slug}")
            for e in errors:
                print(f"              - {e}")
            shutil.rmtree(target, ignore_errors=True)
            failed += 1
            continue

        print(f"  [PUBLISHED] {zp.name} -> {target.relative_to(REPO)}")
        published.setdefault(dataset, []).append(slug)
        archive_zip(zp, batch_root)

    for dataset, slugs in published.items():
        idx = rebuild_index(dataset)
        print(f"  rebuilt {idx.relative_to(REPO)} (+{len(slugs)})")

    total_pub = sum(len(v) for v in published.values())
    print(f"\nSummary: {total_pub} published, {failed} failed.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
