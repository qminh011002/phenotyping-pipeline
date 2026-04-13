"""Inference service wrapping the phenotyping pipeline egg detection logic.

Copies and adapts logic from `phenotyping_pipeline/2_inference/infer_egg.py`.
The service handles tiling, deduplication (center_zone / edge_nms), and overlay generation.
"""

from __future__ import annotations
