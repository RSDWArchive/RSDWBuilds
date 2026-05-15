"""
Generate website/data/tier_pairs.json from the BaseBuilder catalog.

Reads piece entries out of:

    E:/Github/RSDWBaseBuilderWorkspace/CatalogData/_catalog.json

(or a path passed as the first CLI arg) and groups every "tiered" building
piece by its tier-stripped stem so the website's converter page can swap a
piece between Tier 1 / Tier 2 / Tier 3 in any direction.

A piece is considered tiered when its piece_data_name path contains a
`/Tier{1,2,3}_<region>/` folder (e.g. Tier1_Brynmoor, Tier2_Ghornfell,
Tier3_Fellhollow) and its filename starts with `DA_T{1,2,3}_`.

Output schema:

    {
      "schema": "rsdwbuilds.tier_pairs.v1",
      "generated_unix": <int>,
      "source_count": <int>,
      "tiered_count": <int>,
      "stems": {
        "Walls/Wall_Small": {
          "1": {
            "piece_data_index": 409,
            "piece_data_name": "BuildingPieceData /.../DA_T1_Wall_Small.DA_T1_Wall_Small",
            "class_name":      "BlueprintGeneratedClass /.../BP_T1_Wall_Small.BP_T1_Wall_Small_C"
          },
          "2": { ... },
          "3": { ... }
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

Class names are derived mechanically from piece_data_name by replacing the
`DA_` filename prefix with `BP_` and appending `_C` (the convention used in
every observed build .json).
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = Path(
    r"E:/Github/RSDWBaseBuilderWorkspace/CatalogData/_catalog.json"
)
OUT = REPO / "website" / "data" / "tier_pairs.json"

# Primary: "/Game/.../Tier3_Fellhollow/Walls/DA_T3_Wall_Small.DA_T3_Wall_Small".
# Capture: tier digit, category folder(s), stem (rest of asset name).
PATH_RE = re.compile(
    r"/Tier([123])_[^/]+/(.+?)/DA_T\1_(.+?)\.DA_T\1_\3$"
)

# Fallback for assets whose tier is encoded in the filename rather than the
# folder, e.g. all three farm plots live under /Tier1_Brynmoor/Farming/ and
# are named DA_FarmPlot_T{1,2,3}_<Region>.<same>. Capture group 2 is the
# bare prefix we use as the stem.
FALLBACK_RE = re.compile(
    r"/Tier[123]_[^/]+/(.+?)/DA_(.+?)_T([123])_[^./]+\.DA_\2_T\3_[^./]+$"
)


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


def main(argv: list[str]) -> int:
    catalog_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CATALOG
    if not catalog_path.is_file():
        print(f"catalog not found: {catalog_path}", file=sys.stderr)
        return 2

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    pieces = catalog.get("pieces", [])

    stems: dict[str, dict[str, dict]] = {}
    by_data_name: dict[str, dict] = {}
    skipped_examples: list[str] = []

    for p in pieces:
        name = p.get("piece_data_name", "")
        idx = p.get("piece_data_index")
        m = PATH_RE.search(name)
        if m:
            tier, category, stem = m.group(1), m.group(2), m.group(3)
        else:
            mf = FALLBACK_RE.search(name)
            if not mf:
                if len(skipped_examples) < 3 and "/Tier" in name:
                    skipped_examples.append(name)
                continue
            category, stem, tier = mf.group(1), mf.group(2), mf.group(3)
        key = f"{category}/{stem}"
        try:
            class_name = derive_class_name(name)
        except ValueError as exc:
            print(f"  skip {name!r}: {exc}", file=sys.stderr)
            continue

        bucket = stems.setdefault(key, {})
        if tier in bucket:
            print(
                f"  WARN duplicate stem/tier: {key} T{tier} "
                f"(existing index={bucket[tier]['piece_data_index']}, new={idx})",
                file=sys.stderr,
            )
        bucket[tier] = {
            "piece_data_index": idx,
            "piece_data_name": name,
            "class_name": class_name,
        }
        by_data_name[name] = {"stem": key, "tier": int(tier)}

    out = {
        "schema": "rsdwbuilds.tier_pairs.v1",
        "generated_unix": int(time.time()),
        "source_count": len(pieces),
        "tiered_count": len(by_data_name),
        "stems": dict(sorted(stems.items())),
        "by_data_name": by_data_name,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    # Quick stats for the operator.
    coverage = {"1": 0, "2": 0, "3": 0}
    full_triples = 0
    for tiers in stems.values():
        for t in coverage:
            if t in tiers:
                coverage[t] += 1
        if len(tiers) == 3:
            full_triples += 1

    print(f"wrote {OUT.relative_to(REPO)}")
    print(
        f"  source pieces: {len(pieces)}, tiered: {len(by_data_name)}, "
        f"unique stems: {len(stems)}"
    )
    print(
        f"  per-tier coverage: T1={coverage['1']} T2={coverage['2']} T3={coverage['3']}, "
        f"full T1+T2+T3 triples: {full_triples}"
    )
    if skipped_examples:
        print("  examples of /Tier*/ entries that did NOT match the stem regex:")
        for s in skipped_examples:
            print(f"    - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
