"""SamModelService — manage SAM ``.pt`` weight files under data/models/sam/.

Single-active model with no per-organism slot: there is exactly one SAM model
that the larvae refinement pipeline uses, tracked via
``inference_config.yaml::larvae.sam.model``. Weights live as plain files on
disk (no DB row needed); upload writes to ``data/models/sam/<filename>``,
activate updates the YAML, delete unlinks the file.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.config import PipelineConfigManager

logger = logging.getLogger(__name__)

# Max upload size for a SAM model (.pt). Larger than the detection MAX
# because sam2.1_l.pt is ~428 MB.
MAX_SAM_FILE_SIZE: int = 600 * 1024 * 1024

# Names the pipeline repo ships with — never deletable from the UI even if
# they happen to live in the storage dir (they're considered defaults).
_BUILTIN_SAM_FILENAMES: frozenset[str] = frozenset(
    {
        "mobile_sam.pt",
        "sam_b.pt",
        "sam2.1_t.pt",
        "sam2.1_s.pt",
        "sam2.1_b.pt",
        "sam2.1_l.pt",
        "sam2_s.pt",
        "sam2_t.pt",
    }
)

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(name: str) -> str:
    """Sanitise an uploaded filename — basename only, no ``..`` or path seps."""
    base = Path(name).name or "model.pt"
    if not base.lower().endswith(".pt"):
        base = f"{base}.pt"
    return _SAFE_NAME_RE.sub("_", base) or "model.pt"


@dataclass(frozen=True)
class SamModelFile:
    filename: str
    file_size_bytes: int
    uploaded_at: float  # epoch seconds (mtime)
    is_builtin: bool
    is_active: bool


class SamModelNotFoundError(Exception):
    """Raised when an operation targets a SAM model that doesn't exist."""


class SamModelService:
    """File-system-backed catalog of available SAM weights."""

    def __init__(self, weights_dir: Path, config: PipelineConfigManager) -> None:
        self._weights_dir = weights_dir
        self._config = config
        self._weights_dir.mkdir(parents=True, exist_ok=True)

    # ── Listing ─────────────────────────────────────────────────────────────

    def _active_filename(self) -> str:
        return str(self._config.get_larvae_config().sam.model)

    def list_models(self) -> list[SamModelFile]:
        active = self._active_filename()
        out: list[SamModelFile] = []
        for path in sorted(self._weights_dir.glob("*.pt")):
            stat = path.stat()
            out.append(
                SamModelFile(
                    filename=path.name,
                    file_size_bytes=stat.st_size,
                    uploaded_at=stat.st_mtime,
                    is_builtin=path.name in _BUILTIN_SAM_FILENAMES,
                    is_active=(path.name == active),
                )
            )
        return out

    def find(self, filename: str) -> SamModelFile | None:
        target = _safe_filename(filename)
        for entry in self.list_models():
            if entry.filename == target:
                return entry
        return None

    # ── Mutations ───────────────────────────────────────────────────────────

    async def save_uploaded(self, original_filename: str, src_path: Path) -> SamModelFile:
        """Move ``src_path`` into the SAM weights dir under a safe name."""
        safe = _safe_filename(original_filename)
        target = self._weights_dir / safe
        # If a file with this name already exists, replace it (idempotent
        # upload). Refinement will pick up the new weights on its next load.
        await asyncio.to_thread(shutil.move, str(src_path), str(target))
        logger.info(
            "Saved SAM weights %s (%d bytes)", target, target.stat().st_size,
            extra={"context": {"filename": safe}},
        )
        entry = self.find(safe)
        assert entry is not None
        return entry

    def delete(self, filename: str) -> None:
        """Delete a SAM weight file. Refuses to delete builtin or active models."""
        target = self._weights_dir / _safe_filename(filename)
        if not target.is_file():
            raise SamModelNotFoundError(f"SAM model not found: {filename!r}")
        if target.name in _BUILTIN_SAM_FILENAMES:
            raise ValueError(f"Cannot delete builtin SAM model {target.name!r}")
        if target.name == self._active_filename():
            raise ValueError(
                f"Cannot delete the active SAM model {target.name!r}. "
                "Activate another model first."
            )
        target.unlink()
        logger.info(
            "Deleted SAM weights %s", target, extra={"context": {"filename": target.name}}
        )

    def set_active(self, filename: str) -> SamModelFile:
        """Set the active SAM model — updates ``larvae.sam.model`` in YAML."""
        target = self._weights_dir / _safe_filename(filename)
        if not target.is_file():
            raise SamModelNotFoundError(f"SAM model not found: {filename!r}")
        self._config.update_larvae_sam({"model": target.name})
        logger.info(
            "Activated SAM model %s", target.name,
            extra={"context": {"filename": target.name}},
        )
        entry = self.find(target.name)
        assert entry is not None
        return entry

    @property
    def weights_dir(self) -> Path:
        return self._weights_dir
