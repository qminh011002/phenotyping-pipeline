"""Diff a phenotyping_pipeline annotations file against an ecosystem result.

Usage:
    python diff_pipeline_vs_ecosystem.py <pipeline.json> <ecosystem.json>

Reports:
- Annotation count difference
- Per-larva polygon point-set difference (after matching by polygon centroid)
- Bbox / area / confidence drift summary

Use this to confirm byte-for-byte parity between
``phenotyping_pipeline/2_inference`` output and the ecosystem's
``POST /inference/larvae`` output for the same image.

Both inputs must already be in the same coordinate frame (post-warp). If the
pipeline file is pre-warp, run it through the user's warp script first.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _load(path: Path) -> list[dict[str, Any]]:
    """Return the ``annotations`` list from either schema."""
    raw = json.loads(path.read_text())
    if isinstance(raw, list):
        return raw  # bare pipeline format
    if "annotations" in raw:
        return raw["annotations"]
    raise ValueError(f"Unrecognised schema in {path}")


def _centroid(poly: list[list[float]]) -> tuple[float, float]:
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _match(
    a: list[dict[str, Any]], b: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    """Greedy nearest-centroid match (a → b). Returns pairs in `a` order."""
    rem = list(range(len(b)))
    centroids_b = [_centroid(item["polygon"]) for item in b]
    out: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    for ai in a:
        cx, cy = _centroid(ai["polygon"])
        best_i = -1
        best_d = float("inf")
        for ri, j in enumerate(rem):
            bx, by = centroids_b[j]
            d = (cx - bx) ** 2 + (cy - by) ** 2
            if d < best_d:
                best_d = d
                best_i = ri
        if best_i >= 0:
            j = rem.pop(best_i)
            out.append((ai, b[j]))
        else:
            out.append((ai, None))
    return out


def _polygon_equal(p1: list[list[float]], p2: list[list[float]]) -> bool:
    if len(p1) != len(p2):
        return False
    return all(
        int(round(float(p1[i][0]))) == int(round(float(p2[i][0])))
        and int(round(float(p1[i][1]))) == int(round(float(p2[i][1])))
        for i in range(len(p1))
    )


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    pipeline_path = Path(sys.argv[1])
    ecosystem_path = Path(sys.argv[2])
    a = _load(pipeline_path)
    b = _load(ecosystem_path)

    print(f"pipeline   ({pipeline_path.name}): {len(a)} annotations")
    print(f"ecosystem  ({ecosystem_path.name}): {len(b)} annotations")
    if len(a) != len(b):
        print(f"!! count drift: {len(a) - len(b):+d}")

    pairs = _match(a, b)
    poly_same = 0
    poly_diff = 0
    bbox_diff_px = []
    area_diff_pct = []
    conf_diff = []

    for ai, bi in pairs:
        if bi is None:
            poly_diff += 1
            continue
        same = _polygon_equal(ai["polygon"], bi["polygon"])
        if same:
            poly_same += 1
        else:
            poly_diff += 1

        a_bbox = [int(round(float(v))) for v in ai["bbox"]]
        b_bbox = [int(round(float(v))) for v in bi["bbox"]]
        bbox_diff_px.append(max(abs(a - b) for a, b in zip(a_bbox, b_bbox)))

        a_area = float(ai.get("area", ai.get("area_px", 0)))
        b_area = float(bi.get("area", bi.get("area_px", 0)))
        if a_area > 0:
            area_diff_pct.append(abs(a_area - b_area) / a_area * 100.0)

        a_conf = float(ai.get("confidence", 0.0))
        b_conf = float(bi.get("confidence", 0.0))
        conf_diff.append(abs(a_conf - b_conf))

    n = max(1, len(pairs))
    print("---")
    print(f"polygons identical:       {poly_same:5d} / {n}")
    print(f"polygons different:       {poly_diff:5d} / {n}")
    if bbox_diff_px:
        print(
            f"bbox max-pixel drift:     min={min(bbox_diff_px):>3d}  "
            f"avg={sum(bbox_diff_px) / len(bbox_diff_px):>5.2f}  "
            f"max={max(bbox_diff_px):>3d}"
        )
    if area_diff_pct:
        print(
            f"area %% drift:             "
            f"avg={sum(area_diff_pct) / len(area_diff_pct):>5.3f}%  "
            f"max={max(area_diff_pct):>5.3f}%"
        )
    if conf_diff:
        print(
            f"confidence drift:         "
            f"avg={sum(conf_diff) / len(conf_diff):>7.5f}  "
            f"max={max(conf_diff):>7.5f}"
        )

    return 0 if poly_diff == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
