"""
Normalize published RSDWBuilds payload JSONs against the current BaseBuilder catalog.

This is the maintenance version of opening a website payload in BaseBuilder and
exporting it again. It keeps the build/prefab shape intact, but rewrites each
piece's catalog identifiers to the current BaseBuilder index and adds explicit
pitch/roll/scale fields expected by newer tooling.

Usage:
    python tools/normalize_payloads_with_basebuilder.py --dry-run
    python tools/normalize_payloads_with_basebuilder.py --write
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
WEBSITE = REPO / "website"
DATA = WEBSITE / "data"
DEFAULT_CATALOG = Path("E:/Github/RSDWBaseBuilder/website/basebuilder-index.json")

DATASETS = ("builds", "prefabs")
IGNORED_PAYLOAD_NAMES = {"build.json", "index.json", "all.json", "tier_pairs.json"}
BUILD_SCHEMA = "rsdwtools.buildings.v1"

PIECE_ORDER = (
    "piece_id",
    "piece_data_index",
    "piece_data_name",
    "class_name",
    "x",
    "y",
    "z",
    "pitch",
    "yaw",
    "roll",
    "scale_x",
    "scale_y",
    "scale_z",
    "stability",
    "is_ghosted",
    "spud_guid",
)

TRANSFORM_DEFAULTS = {
    "x": 0,
    "y": 0,
    "z": 0,
    "pitch": 0,
    "yaw": 0,
    "roll": 0,
    "scale_x": 1,
    "scale_y": 1,
    "scale_z": 1,
}


@dataclass
class Lookup:
    version: str
    by_piece_class: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_piece_data_name: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_item_name: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_bp_class: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class NormalizedFile:
    path: Path
    data: dict[str, Any]
    changed: bool
    semantic_changed: bool
    format_changed: bool
    pieces: int
    piece_changes: Counter[str]
    defaults_added: Counter[str]
    unresolved: list[str]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def render_json(data: Any, style: str) -> str:
    if style == "pretty":
        return json.dumps(data, indent=2) + "\n"
    return json.dumps(data, separators=(",", ":")) + "\n"


def write_json(path: Path, data: Any, style: str) -> None:
    path.write_text(render_json(data, style), encoding="utf-8")


def shorten_class(class_name: Any) -> str:
    text = str(class_name or "")
    if not text:
        return ""
    return text.split("/")[-1].split(".")[-1]


def piece_data_stem(piece_data_name: Any) -> str:
    text = re.sub(r"^BuildingPieceData\s+", "", str(piece_data_name or ""))
    if not text:
        return ""
    return text.split("/")[-1].split(".")[0]


def number_or(value: Any, fallback: float = 0) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return n if math.isfinite(n) else fallback


def js_round(value: Any, digits: int = 3) -> int | float:
    scale = 10**digits
    rounded = math.floor(number_or(value) * scale + 0.5) / scale
    if rounded == 0:
        return 0
    if rounded.is_integer():
        return int(rounded)
    return rounded


def json_number(value: Any, fallback: float = 0) -> int | float:
    n = number_or(value, fallback)
    if n == 0:
        return 0
    if n.is_integer():
        return int(n)
    return n


def boolish(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def build_lookup(catalog_path: Path) -> Lookup:
    catalog = read_json(catalog_path)
    lookup = Lookup(version=str(catalog.get("version") or "unknown"))
    for target in catalog.get("targets") or []:
        if not isinstance(target, dict):
            continue
        export = target.get("export") or {}
        kind = target.get("asset_kind")
        if kind == "building_piece":
            if export.get("bp_class"):
                lookup.by_piece_class[str(export["bp_class"])] = target
            if export.get("class_name"):
                lookup.by_piece_class[shorten_class(export["class_name"])] = target
            if export.get("piece_data_name"):
                lookup.by_piece_data_name[piece_data_stem(export["piece_data_name"])] = target
        elif kind == "item":
            key = export.get("item_asset_name") or target.get("asset_stem")
            if key:
                lookup.by_item_name[str(key)] = target
        elif kind == "bp":
            if export.get("bp_class"):
                lookup.by_bp_class[str(export["bp_class"])] = target
            if export.get("actor_class"):
                lookup.by_bp_class[shorten_class(export["actor_class"])] = target
    return lookup


def iter_entry_dirs() -> list[tuple[str, Path]]:
    entries: list[tuple[str, Path]] = []
    for dataset in DATASETS:
        root = DATA / dataset
        if not root.is_dir():
            continue
        entries.extend((dataset, p) for p in sorted(root.iterdir()) if p.is_dir())
    return entries


def iter_payloads() -> list[Path]:
    payloads: list[Path] = []
    for _, folder in iter_entry_dirs():
        for path in sorted(folder.glob("*.json")):
            if path.name not in IGNORED_PAYLOAD_NAMES:
                payloads.append(path)
    return payloads


def audit_download_payloads() -> list[str]:
    issues: list[str] = []
    for dataset, folder in iter_entry_dirs():
        label = f"{dataset}/{folder.name}"
        card_path = folder / "build.json"
        if not card_path.is_file():
            issues.append(f"{label}: missing build.json")
            continue
        try:
            card = read_json(card_path)
        except (OSError, json.JSONDecodeError) as exc:
            issues.append(f"{label}: invalid build.json ({exc})")
            continue
        download = card.get("download")
        if not isinstance(download, str) or not download:
            issues.append(f"{label}: missing download field")
            continue
        payload_path = folder / download
        if not payload_path.is_file():
            issues.append(f"{label}: download file missing ({download})")
            continue
        if payload_path.suffix.lower() != ".json":
            issues.append(f"{label}: download is not a .json ({download})")
        try:
            header = payload_path.read_bytes()[:4]
        except OSError as exc:
            issues.append(f"{label}: could not read download ({exc})")
            continue
        if header.startswith(b"PK"):
            issues.append(f"{label}: download appears to be a zip file ({download})")
            continue
        try:
            payload = read_json(payload_path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            issues.append(f"{label}: download JSON invalid ({download}: {exc})")
            continue
        if not isinstance(payload, dict):
            issues.append(f"{label}: download JSON must be an object ({download})")
        elif not isinstance(payload.get("pieces"), list):
            issues.append(f"{label}: download JSON missing pieces array ({download})")

        for zip_path in sorted(folder.glob("*.zip")):
            issues.append(f"{label}: entry folder contains stray zip ({zip_path.name})")
    return issues


def resolve_piece(row: dict[str, Any], lookup: Lookup) -> dict[str, Any] | None:
    return (
        lookup.by_piece_class.get(shorten_class(row.get("class_name")))
        or lookup.by_piece_data_name.get(piece_data_stem(row.get("piece_data_name")))
    )


def export_transform(row: dict[str, Any]) -> tuple[dict[str, int | float], Counter[str]]:
    defaults_added: Counter[str] = Counter()
    transform: dict[str, int | float] = {}
    for key, fallback in TRANSFORM_DEFAULTS.items():
        if key not in row:
            defaults_added[key] += 1
        digits = 6 if key.startswith("scale_") else 3
        transform[key] = js_round(row.get(key, fallback), digits)
    return transform, defaults_added


def ordered_piece(row: dict[str, Any], target: dict[str, Any]) -> tuple[dict[str, Any], Counter[str], Counter[str]]:
    export = target.get("export") or {}
    transform, defaults_added = export_transform(row)
    default_stability = export.get("default_stability", 3000)
    out: dict[str, Any] = {
        "piece_id": int(number_or(row.get("piece_id"))),
        "piece_data_index": int(number_or(export.get("piece_data_index"))),
        "piece_data_name": export.get("piece_data_name") or "",
        "class_name": export.get("class_name") or "",
        **transform,
        "stability": json_number(row.get("stability"), number_or(default_stability, 3000)),
        "is_ghosted": boolish(row.get("is_ghosted")),
    }
    if row.get("spud_guid"):
        out["spud_guid"] = row["spud_guid"]

    for key, value in row.items():
        if key not in out and key not in PIECE_ORDER:
            out[key] = value

    changes: Counter[str] = Counter()
    if int(number_or(row.get("piece_data_index"))) != out["piece_data_index"]:
        changes["piece_data_index"] += 1
    if row.get("piece_data_name") != out["piece_data_name"]:
        changes["piece_data_name"] += 1
    if row.get("class_name") != out["class_name"]:
        changes["class_name"] += 1
    for key, value in transform.items():
        if key not in row or js_round(row.get(key), 6 if key.startswith("scale_") else 3) != value:
            changes[key] += 1
    return out, changes, defaults_added


def normalize_payload(path: Path, lookup: Lookup, now: int, style: str) -> NormalizedFile:
    original = read_json(path)
    if not isinstance(original, dict):
        raise ValueError("payload JSON must be an object")

    pieces: list[dict[str, Any]] = []
    piece_changes: Counter[str] = Counter()
    defaults_added: Counter[str] = Counter()
    unresolved: list[str] = []

    for index, row in enumerate(original.get("pieces") or [], start=1):
        if not isinstance(row, dict):
            unresolved.append(f"piece #{index}: row is not an object")
            continue
        target = resolve_piece(row, lookup)
        if not target:
            unresolved.append(
                f"piece #{index}: class={shorten_class(row.get('class_name')) or '?'} "
                f"piece_data={piece_data_stem(row.get('piece_data_name')) or '?'}"
            )
            pieces.append(dict(row))
            continue
        out, changes, added = ordered_piece(row, target)
        pieces.append(out)
        piece_changes.update(changes)
        defaults_added.update(added)

    items = original.get("items") if isinstance(original.get("items"), list) else []
    actors = original.get("actors") if isinstance(original.get("actors"), list) else []

    out: dict[str, Any] = {
        "schema": original.get("schema") or BUILD_SCHEMA,
        "name": original.get("name") or path.stem,
        "generated_unix": int(number_or(original.get("generated_unix"), now)),
        "count": len(pieces),
        "skipped": len(unresolved),
        "item_count": len(items),
        "item_skipped": int(number_or(original.get("item_skipped"), 0)),
        "hidden": int(number_or(original.get("hidden"), 0)),
        "pieces": pieces,
        "items": items,
        "actors": actors,
    }

    anchor_piece_id = int(number_or(original.get("anchor_piece_id"), 0))
    if anchor_piece_id:
        anchor = next((piece for piece in pieces if int(number_or(piece.get("piece_id"))) == anchor_piece_id), None)
        if anchor:
            out["anchor_piece_id"] = anchor_piece_id
            out["anchor_piece_data_index"] = int(number_or(anchor.get("piece_data_index")))

    known_top_level = {
        "schema",
        "name",
        "generated_unix",
        "count",
        "skipped",
        "item_count",
        "item_skipped",
        "hidden",
        "pieces",
        "items",
        "actors",
        "anchor_piece_id",
        "anchor_piece_data_index",
    }
    for key, value in original.items():
        if key not in out and key not in known_top_level:
            out[key] = value

    semantic_changed = out != original
    if semantic_changed:
        out["generated_unix"] = now
    format_changed = path.read_text(encoding="utf-8") != render_json(out, style)
    return NormalizedFile(
        path=path,
        data=out,
        changed=semantic_changed or format_changed,
        semantic_changed=semantic_changed,
        format_changed=format_changed,
        pieces=len(pieces),
        piece_changes=piece_changes,
        defaults_added=defaults_added,
        unresolved=unresolved,
    )


def summarize(results: list[NormalizedFile], audit_issues: list[str], lookup: Lookup) -> None:
    changed = [result for result in results if result.changed]
    semantic_changed = [result for result in results if result.semantic_changed]
    format_changed = [result for result in results if result.format_changed]
    piece_changes: Counter[str] = Counter()
    defaults_added: Counter[str] = Counter()
    unresolved: list[tuple[Path, list[str]]] = []
    for result in results:
        piece_changes.update(result.piece_changes)
        defaults_added.update(result.defaults_added)
        if result.unresolved:
            unresolved.append((result.path, result.unresolved))

    print(f"BaseBuilder catalog: {lookup.version}")
    print(f"Download audit: {len(iter_entry_dirs())} entries, {len(audit_issues)} issue(s)")
    print(f"Payloads scanned: {len(results)}")
    print(f"Payloads needing rewrite: {len(changed)}")
    print(f"Payload semantic changes: {len(semantic_changed)}")
    print(f"Payload format changes: {len(format_changed)}")
    print(f"Pieces scanned: {sum(result.pieces for result in results)}")
    if piece_changes:
        print("Piece changes:")
        for key, value in piece_changes.most_common():
            print(f"  {key}: {value}")
    if defaults_added:
        print("Defaults added:")
        for key, value in defaults_added.most_common():
            print(f"  {key}: {value}")
    if audit_issues:
        print("Download audit issues:")
        for issue in audit_issues[:50]:
            print(f"  - {issue}")
        if len(audit_issues) > 50:
            print(f"  ...and {len(audit_issues) - 50} more")
    if unresolved:
        print("Unresolved pieces:")
        for path, entries in unresolved[:20]:
            print(f"  - {path.relative_to(REPO)}")
            for entry in entries[:5]:
                print(f"      {entry}")
            if len(entries) > 5:
                print(f"      ...and {len(entries) - 5} more")
        if len(unresolved) > 20:
            print(f"  ...and {len(unresolved) - 20} more files")
    if changed:
        print("Changed payloads:")
        for result in changed:
            print(f"  - {result.path.relative_to(REPO)}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Report changes without writing files")
    mode.add_argument("--write", action="store_true", help="Rewrite payloads in place")
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help=f"BaseBuilder catalog path (default: {DEFAULT_CATALOG})",
    )
    parser.add_argument(
        "--format",
        choices=("compact", "pretty"),
        default="compact",
        help="JSON output style for payload files (default: compact)",
    )
    parser.add_argument(
        "--allow-audit-issues",
        action="store_true",
        help="Continue normalization even when the download-format audit finds issues",
    )
    args = parser.parse_args(argv[1:])

    catalog_path = args.catalog.resolve()
    if not catalog_path.is_file():
        print(f"BaseBuilder catalog not found: {catalog_path}", file=sys.stderr)
        return 2

    audit_issues = audit_download_payloads()
    if audit_issues and not args.allow_audit_issues:
        lookup = build_lookup(catalog_path)
        summarize([], audit_issues, lookup)
        print("Refusing to normalize until download audit issues are fixed.", file=sys.stderr)
        return 1

    lookup = build_lookup(catalog_path)
    now = int(time.time())
    results: list[NormalizedFile] = []
    for path in iter_payloads():
        try:
            results.append(normalize_payload(path, lookup, now, args.format))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            print(f"Could not normalize {path.relative_to(REPO)}: {exc}", file=sys.stderr)
            return 1

    if any(result.unresolved for result in results):
        summarize(results, audit_issues, lookup)
        print("Refusing to write while pieces are unresolved.", file=sys.stderr)
        return 1

    if args.write:
        for result in results:
            if result.changed:
                write_json(result.path, result.data, args.format)

    summarize(results, audit_issues, lookup)
    if args.dry_run:
        print("Dry run only; no files were written.")
    else:
        print("Normalization complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
