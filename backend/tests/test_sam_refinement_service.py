"""Tests for SAM refinement performance guards."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import numpy as np

from app.schemas.config import LarvaeConfig
from app.services.inference.sam_refine import SamRefinementService


def _larvae_cfg(sam_threshold: float) -> LarvaeConfig:
    return LarvaeConfig(
        device="cpu",
        tile_size=512,
        overlap=0.5,
        confidence_threshold=0.4,
        min_mask_size=100,
        edge_margin=5,
        mwis_overlap_threshold=0.3,
        mwis_score_metric="confidence_x_area",
        batch_size=24,
        sam={
            "enabled": True,
            "model": "mobile_sam.pt",
            "confidence_threshold": sam_threshold,
        },
    )


def test_refine_candidates_skips_model_load_when_all_below_threshold(tmp_path):
    executor = ThreadPoolExecutor(max_workers=1)
    svc = SamRefinementService(executor=executor, weights_dir=tmp_path)
    svc._ensure_model = MagicMock(side_effect=AssertionError("SAM should not load"))

    image = np.zeros((128, 128, 3), dtype=np.uint8)
    candidates = [
        {"bbox": (10, 10, 40, 40), "confidence": 0.2},
        {"bbox": (50, 50, 90, 90), "confidence": 0.3},
    ]

    try:
        result = svc.refine_candidates(image, candidates, _larvae_cfg(0.9))
    finally:
        executor.shutdown(wait=False)

    assert result is candidates
    svc._ensure_model.assert_not_called()


def test_refine_candidates_only_refines_above_threshold_and_preserves_order(tmp_path):
    executor = ThreadPoolExecutor(max_workers=1)
    svc = SamRefinementService(executor=executor, weights_dir=tmp_path)
    svc._ensure_model = MagicMock(return_value=object())

    def _refine_one(model, image, candidate, padding, **kwargs):
        refined = dict(candidate)
        refined["refined"] = True
        return refined

    svc._refine_one = MagicMock(side_effect=_refine_one)

    image = np.zeros((128, 128, 3), dtype=np.uint8)
    candidates = [
        {"bbox": (10, 10, 40, 40), "confidence": 0.2, "id": "skip"},
        {"bbox": (50, 50, 90, 90), "confidence": 0.95, "id": "refine"},
    ]

    try:
        result = svc.refine_candidates(image, candidates, _larvae_cfg(0.9))
    finally:
        executor.shutdown(wait=False)

    assert result[0] is candidates[0]
    assert result[1]["id"] == "refine"
    assert result[1]["refined"] is True
    svc._ensure_model.assert_called_once()
    svc._refine_one.assert_called_once()
