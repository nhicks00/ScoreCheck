"""Shared identity checks for independently protected store roots."""

from __future__ import annotations

import os
from pathlib import Path
import stat


def validate_distinct_protected_store_namespaces(*roots: Path) -> None:
    """Require existing, non-symlink directory roots with distinct identities."""

    if len(roots) < 2:
        raise ValueError("at least two protected store roots are required")
    identities: set[tuple[int, int]] = set()
    canonical_names: set[str] = set()
    for root in roots:
        if not isinstance(root, Path):
            raise ValueError("store root must be a pathlib.Path")
        link_value = root.lstat()
        value = root.stat()
        if (
            stat.S_ISLNK(link_value.st_mode)
            or not stat.S_ISDIR(link_value.st_mode)
            or not stat.S_ISDIR(value.st_mode)
        ):
            raise ValueError("store root must be a non-symlink directory")
        identity = (value.st_dev, value.st_ino)
        canonical = os.path.normcase(os.path.realpath(os.fspath(root))).casefold()
        if identity in identities or canonical in canonical_names:
            raise ValueError("protected store roots must be distinct namespaces")
        identities.add(identity)
        canonical_names.add(canonical)


__all__ = ["validate_distinct_protected_store_namespaces"]
