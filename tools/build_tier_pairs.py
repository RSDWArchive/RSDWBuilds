"""
Generate website/data/tier_pairs.json from the BaseBuilder catalog.

Reads building-piece entries out of the current BaseBuilder website index:

    E:/Github/RSDWBaseBuilder/website/basebuilder-index.json

(or a path passed as the first CLI arg) and groups every "tiered" building
piece by its tier-stripped stem so the website's converter page can swap a
piece between Tier 1 / Tier 2 / Tier 3 / Tier 4 in any direction.

A piece is considered tiered when its piece_data_name path contains a
`/Tier{1,2,3,4}_<region>/` folder (e.g. Tier1_Brynmoor, Tier2_Ghornfell,
Tier3_Fellhollow, Tier4_UmbralSands) and its filename starts with
`DA_T{1,2,3,4}_`.

Output schema:

    {
      "schema": "rsdwbuilds.tier_pairs.v2",
      "generated_unix": <int>,
      "source_catalog": "basebuilder-index.json",
      "source_version": "0.12.0.0",
      "source_count": <int>,
      "tiered_count": <int>,
      "tiers": [1, 2, 3, 4],
      "stems": {
        "Walls/Wall_Small": {
          "1": {
            "piece_data_index": 409,
            "piece_data_name": "BuildingPieceData /.../DA_T1_Wall_Small.DA_T1_Wall_Small",
            "class_name":      "BlueprintGeneratedClass /.../BP_T1_Wall_Small.BP_T1_Wall_Small_C"
          },
          "2": { ... },
          "3": { ... }
          "4": { ... }
        },
        ...
      },
      "by_data_name": {
        "BuildingPieceData /.../DA_T3_Wall_Small.DA_T3_Wall_Small": {
          "stem": "Walls/Wall_Small",
          "tier": 3
        },
        ...
      }
    }

The current BaseBuilder index already contains authoritative class names and
piece indexes; the older `_catalog.json` shape is still accepted as a fallback
when passed explicitly.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = Path(r"E:/Github/RSDWBaseBuilder/website/basebuilder-index.json")
FALLBACK_CATALOG = Path(r"E:/Github/RSDWBaseBuilderWorkspace/CatalogData/_catalog.json")
OUT = REPO / "website" / "data" / "tier_pairs.json"
TIERS = ("1", "2", "3", "4")

# Primary: "/Game/.../Tier3_Fellhollow/Walls/DA_T3_Wall_Small.DA_T3_Wall_Small".
# Capture: tier digit, category folder(s), stem (rest of asset name).
PATH_RE = re.compile(
    r"/Tier([1234])_[^/]+/(.+?)/DA_T\1_(.+?)\.DA_T\1_\3$"
)

# Some current Tier 4 entries live under /Tier4_UmbralSands/ but retain a
# DA_T3_ asset name. The folder tier is the game tier we care about here.
LOOSE_PATH_RE = re.compile(
    r"/Tier([1234])_[^/]+/(.+?)/DA_T[1234]_(.+?)\.DA_T[1234]_\3$"
)

# Fallback for assets whose tier is encoded in the filename rather than the
# folder, e.g. all three farm plots live under /Tier1_Brynmoor/Farming/ and
# are named DA_FarmPlot_T{1,2,3}_<Region>.<same>. Capture group 2 is the
# bare prefix we use as the stem.
FALLBACK_RE = re.compile(
    r"/Tier[1234]_[^/]+/(.+?)/DA_(.+?)_T([1234])_[^./]+\.DA_\2_T\3_[^./]+$"
)

VARIANT_RE = re.compile(r"^(.*?)(0?[1-9][0-9]?)$")


def derive_class_name(piece_data_name: str) -> str:
    """Convert 'BuildingPieceData /a/b/DA_X.DA_X' -> 'BlueprintGeneratedClass /a/b/BP_X.BP_X_C'."""
    if not piece_data_name.startswith("BuildingPieceData "):
        raise ValueError(f"unexpected prefix: {piece_data_name!r}")
    path = piece_data_name[len("BuildingPieceData "):]
    head, _, tail = path.rpartition("/")
    asset_pkg, _, asset_obj = tail.partition(".")
    if not asset_pkg.startswith("DA_") or asset_obj != asset_pkg:
        raise ValueError(f"not a DA_-style asset: {piece_data_name!r}")
    bp_pkg = "BP_" + asset_pkg[len("DA_"):]
    return f"BlueprintGeneratedClass {head}/{bp_pkg}.{bp_pkg}_C"


def iter_piece_exports(catalog: dict) -> tuple[str, str, list[dict]]:
    """Return (source_kind, source_version, piece export rows)."""
    if isinstance(catalog.get("targets"), list):
        rows = []
        for target in catalog.get("targets") or []:
            if not isinstance(target, dict) or target.get("asset_kind") != "building_piece":
                continue
            export = target.get("export") or {}
            if not export.get("piece_data_name"):
                continue
            rows.append(
                {
                    "piece_data_index": export.get("piece_data_index"),
                    "piece_data_name": export.get("piece_data_name", ""),
                    "class_name": export.get("class_name", ""),
                }
            )
        return "basebuilder-index", str(catalog.get("version") or ""), rows

    rows = []
    for piece in catalog.get("pieces") or []:
        if not isinstance(piece, dict) or not piece.get("piece_data_name"):
            continue
        class_name = piece.get("class_name")
        if not class_name:
            class_name = derive_class_name(piece.get("piece_data_name", ""))
        rows.append(
            {
                "piece_data_index": piece.get("piece_data_index"),
                "piece_data_name": piece.get("piece_data_name", ""),
                "class_name": class_name,
            }
        )
    return "legacy-catalog", "", rows


def canonical_stem(tier: str, category: str, stem: str) -> tuple[str, int]:
    """Return the converter stem and a duplicate-choice rank.

    Tier 4 has several visual variants encoded as trailing numbers, such as
    Wall_Large01 and Wall_Large02. The converter has one target slot per
    tier/stem, so we group those under the lower-tier stem and prefer variant
    1 as the default conversion target.
    """
    if tier != "4":
        return f"{category}/{stem}", 0

    match = VARIANT_RE.match(stem)
    rank = 0
    if match:
        stem = match.group(1).rstrip("_")
        rank = int(match.group(2))

    if category == "Roofs" and stem.startswith("Flat_Roof_"):
        stem = "Roof_" + stem[len("Flat_Roof_"):]

    return f"{category}/{stem}", rank


def parse_tiered_piece(piece_data_name: str) -> tuple[str, str, str] | None:
    m = PATH_RE.search(piece_data_name)
    if m:
        return m.group(1), m.group(2), m.group(3)

    ml = LOOSE_PATH_RE.search(piece_data_name)
    if ml:
        return ml.group(1), ml.group(2), ml.group(3)

    mf = FALLBACK_RE.search(piece_data_name)
    if mf:
        return mf.group(3), mf.group(1), mf.group(2)

    return None


def main(argv: list[str]) -> int:
    catalog_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CATALOG
    if len(argv) <= 1 and not catalog_path.is_file() and FALLBACK_CATALOG.is_file():
        catalog_path = FALLBACK_CATALOG
    if not catalog_path.is_file():
        print(f"catalog not found: {catalog_path}", file=sys.stderr)
        return 2

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    source_kind, source_version, pieces = iter_piece_exports(catalog)

    stems: dict[str, dict[str, dict]] = {}
    by_data_name: dict[str, dict] = {}
    choice_rank: dict[tuple[str, str], int] = {}
    skipped_examples: list[str] = []

    for p in pieces:
        name = p.get("piece_data_name", "")
        idx = p.get("piece_data_index")
        parsed = parse_tiered_piece(name)
        if not parsed:
            if len(skipped_examples) < 3 and "/Tier" in name:
                skipped_examples.append(name)
            continue
        tier, category, stem = parsed
        key, rank = canonical_stem(tier, category, stem)
        class_name = p.get("class_name") or ""
        if not class_name:
            try:
                class_name = derive_class_name(name)
            except ValueError as exc:
                print(f"  skip {name!r}: {exc}", file=sys.stderr)
                continue

        bucket = stems.setdefault(key, {})
        if tier in bucket:
            old_rank = choice_rank.get((key, tier), 0)
            old_index = bucket[tier].get("piece_data_index") or 0
            new_index = idx or 0
            if (rank, new_index) >= (old_rank, old_index):
                by_data_name[name] = {"stem": key, "tier": int(tier)}
                continue
        bucket[tier] = {
            "piece_data_index": idx,
            "piece_data_name": name,
            "class_name": class_name,
        }
        choice_rank[(key, tier)] = rank
        by_data_name[name] = {"stem": key, "tier": int(tier)}

    out = {
        "schema": "rsdwbuilds.tier_pairs.v2",
        "generated_unix": int(time.time()),
        "source_catalog": source_kind,
        "source_version": source_version,
        "source_count": len(pieces),
        "tiered_count": len(by_data_name),
        "tiers": [int(t) for t in TIERS],
        "tier_labels": {t: f"Tier {t}" for t in TIERS},
        "stems": dict(sorted(stems.items())),
        "by_data_name": by_data_name,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    # Quick stats for the operator.
    coverage = {tier: 0 for tier in TIERS}
    full_sets = 0
    for tiers in stems.values():
        for t in coverage:
            if t in tiers:
                coverage[t] += 1
        if all(t in tiers for t in TIERS):
            full_sets += 1

    print(f"wrote {OUT.relative_to(REPO)}")
    print(
        f"  source pieces: {len(pieces)}, tiered: {len(by_data_name)}, "
        f"unique stems: {len(stems)}"
    )
    print(
        "  per-tier coverage: "
        + " ".join(f"T{tier}={coverage[tier]}" for tier in TIERS)
        + f", full T1+T2+T3+T4 sets: {full_sets}"
    )
    if skipped_examples:
        print("  examples of /Tier*/ entries that did NOT match the stem regex:")
        for s in skipped_examples:
            print(f"    - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
