#!/usr/bin/env python3
"""Small JSON bridge for turbovec's Python bindings.

The pi extension is TypeScript, while turbovec currently exposes Python/Rust
APIs. This helper keeps all vector-index operations in one short-lived Python
process per batch/search and stores the index as .pi/rag/rag.tvim.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any


def respond(value: dict[str, Any], status: int = 0) -> None:
    print(json.dumps(value, separators=(",", ":")))
    raise SystemExit(status)


def fail(message: str, status: int = 1) -> None:
    respond({"ok": False, "error": message}, status)


try:
    import numpy as np
    from turbovec import IdMapIndex
except Exception as exc:  # pragma: no cover - exercised from Node at runtime
    fail(
        "Python package 'turbovec' is not installed or failed to import. "
        "Install it with: python3 -m pip install turbovec. "
        f"Import error: {exc}"
    )


def load_or_new(path: str, dim: int, bit_width: int) -> Any:
    if os.path.exists(path):
        return IdMapIndex.load(path)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return IdMapIndex(dim=dim, bit_width=bit_width)


def as_vectors(value: Any, dim: int) -> Any:
    vectors = np.asarray(value, dtype=np.float32)
    if vectors.ndim == 1:
        vectors = vectors.reshape(1, -1)
    if vectors.ndim != 2 or vectors.shape[1] != dim:
        raise ValueError(f"vectors must have shape (n, {dim}); got {vectors.shape}")
    return np.ascontiguousarray(vectors, dtype=np.float32)


def as_ids(value: Any) -> Any:
    return np.ascontiguousarray(np.asarray(value, dtype=np.uint64))


def cmd_add(req: dict[str, Any]) -> None:
    path = str(req["indexFile"])
    dim = int(req["dim"])
    bit_width = int(req.get("bitWidth", 4))
    ids = as_ids(req.get("ids", []))
    vectors = as_vectors(req.get("vectors", []), dim)
    if len(ids) != vectors.shape[0]:
        raise ValueError(f"ids length {len(ids)} != vectors rows {vectors.shape[0]}")
    if len(ids) == 0:
        respond({"ok": True, "count": None})

    idx = load_or_new(path, dim, bit_width)
    idx.add_with_ids(vectors, ids)
    idx.write(path)
    respond({"ok": True, "count": len(idx)})


def cmd_remove(req: dict[str, Any]) -> None:
    path = str(req["indexFile"])
    ids = [int(x) for x in req.get("ids", [])]
    if not ids or not os.path.exists(path):
        respond({"ok": True, "removed": 0})

    idx = IdMapIndex.load(path)
    removed = 0
    for id_ in ids:
        if idx.remove(id_):
            removed += 1
    idx.write(path)
    respond({"ok": True, "removed": removed, "count": len(idx)})


def cmd_search(req: dict[str, Any]) -> None:
    path = str(req["indexFile"])
    if not os.path.exists(path):
        respond({"ok": True, "results": []})

    dim = int(req["dim"])
    query = as_vectors([req["query"]], dim)
    k = int(req.get("k", 8))
    allow = req.get("allowlist")
    if allow is not None and len(allow) == 0:
        respond({"ok": True, "results": []})

    idx = IdMapIndex.load(path)
    if len(idx) == 0:
        respond({"ok": True, "results": []})

    kwargs: dict[str, Any] = {}
    if allow is not None:
        kwargs["allowlist"] = as_ids(allow)

    scores, ids = idx.search(query, k=k, **kwargs)
    scores0 = np.asarray(scores)[0] if np.asarray(scores).ndim == 2 else np.asarray(scores)
    ids0 = np.asarray(ids)[0] if np.asarray(ids).ndim == 2 else np.asarray(ids)
    results = [
        {"id": int(id_), "score": float(score)}
        for score, id_ in zip(scores0.tolist(), ids0.tolist())
    ]
    respond({"ok": True, "results": results})


def cmd_count(req: dict[str, Any]) -> None:
    path = str(req["indexFile"])
    if not os.path.exists(path):
        respond({"ok": True, "count": 0})
    idx = IdMapIndex.load(path)
    respond({"ok": True, "count": len(idx), "dim": idx.dim, "bitWidth": idx.bit_width})


def main() -> None:
    try:
        req = json.load(sys.stdin)
        cmd = req.get("cmd")
        if cmd == "add":
            cmd_add(req)
        if cmd == "remove":
            cmd_remove(req)
        if cmd == "search":
            cmd_search(req)
        if cmd == "count":
            cmd_count(req)
        fail(f"unknown command: {cmd}")
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
