"""Filesystem layout for detection models.

Owns the on-disk source of truth at ``data/models/<organism>/{default,custom}/``:

- ``default/`` — operator-placed weight files. The first ``.pt`` here (sorted by
  filename) is treated as the organism's default model. The repo does not ship
  any weights — operators drop a ``best.pt`` (or any ``.pt``) into the matching
  default folder before starting the backend.
- ``custom/`` — files uploaded via ``POST /models/{organism}/upload``. The
  upload service writes ``<uuid>_<original_name>.pt`` here.

Active-model resolution (per organism):

1. If a ``model_assignment`` row points to a ``custom_model`` whose file
   exists on disk → use that file.
2. Else, the first ``.pt`` (sorted by filename) under ``default/``.
3. Else, the organism is unavailable.

This module is intentionally synchronous — callers offload via ``asyncio.to_thread``
when invoked from async handlers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

VALID_ORGANISMS: tuple[str, ...] = ("egg", "larvae", "pupae", "neonate")


@dataclass(frozen=True)
class ResolvedModel:
    """The active weight file for an organism plus where it came from."""

    path: Path
    is_default: bool
    """True if resolved from ``default/``; False if from a custom assignment."""


class ModelStorage:
    """Filesystem-only source of truth for detection model weights."""

    def __init__(self, data_dir: Path) -> None:
        self._root = data_dir / "models"

    # ── Layout helpers ─────────────────────────────────────────────────────────

    @property
    def root(self) -> Path:
        return self._root

    def organism_dir(self, organism: str) -> Path:
        return self._root / organism

    def default_dir(self, organism: str) -> Path:
        return self._root / organism / "default"

    def custom_dir(self, organism: str) -> Path:
        return self._root / organism / "custom"

    def ensure_layout(self) -> None:
        """Create every ``<organism>/{default,custom}/`` folder if missing.

        Safe to call on every startup. Cheap.
        """
        for organism in VALID_ORGANISMS:
            self.default_dir(organism).mkdir(parents=True, exist_ok=True)
            self.custom_dir(organism).mkdir(parents=True, exist_ok=True)

    # ── Default-model discovery ────────────────────────────────────────────────

    def find_default_model(self, organism: str) -> Path | None:
        """Return the first ``.pt`` in ``<organism>/default/``, or None."""
        d = self.default_dir(organism)
        if not d.is_dir():
            return None
        candidates = sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".pt")
        return candidates[0] if candidates else None

    # ── Active-model resolution ────────────────────────────────────────────────

    def resolve_active(
        self, organism: str, custom_path: Path | None
    ) -> ResolvedModel | None:
        """Return the active weight file for ``organism``.

        Parameters
        ----------
        custom_path
            The ``stored_path`` from a ``model_assignment`` → ``custom_model`` row,
            if any. Pass ``None`` to skip directly to the default lookup.
        """
        if custom_path is not None and custom_path.is_file():
            return ResolvedModel(path=custom_path, is_default=False)
        default = self.find_default_model(organism)
        if default is not None:
            return ResolvedModel(path=default, is_default=True)
        return None

    # ── One-shot migration from the old ``data/models/custom/<organism>/`` layout ──

    def migrate_legacy_custom_layout(self) -> list[tuple[Path, Path]]:
        """Move files from the legacy ``data/models/custom/<organism>/`` layout
        into the new ``data/models/<organism>/custom/`` layout.

        Returns the list of ``(old_path, new_path)`` pairs actually moved so the
        caller can update DB rows that reference ``stored_path``. Safe to call
        on every startup — a no-op once the legacy folder is gone.
        """
        moved: list[tuple[Path, Path]] = []
        legacy_root = self._root / "custom"
        if not legacy_root.is_dir():
            return moved

        for organism in VALID_ORGANISMS:
            legacy_org = legacy_root / organism
            if not legacy_org.is_dir():
                continue
            new_org = self.custom_dir(organism)
            new_org.mkdir(parents=True, exist_ok=True)
            for src in legacy_org.iterdir():
                if not src.is_file():
                    continue
                dst = new_org / src.name
                if dst.exists():
                    # Already migrated — drop the duplicate to keep the layout clean.
                    src.unlink(missing_ok=True)
                    continue
                src.rename(dst)
                moved.append((src, dst))
                logger.info(
                    "Migrated custom model %s → %s",
                    src,
                    dst,
                    extra={"context": {"old": str(src), "new": str(dst)}},
                )
            try:
                legacy_org.rmdir()
            except OSError:
                pass
        try:
            legacy_root.rmdir()
        except OSError:
            pass
        return moved
