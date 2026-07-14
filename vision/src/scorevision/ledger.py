"""Append-only experiment ledger (the agent-readable model registry).

One JSONL line per training run, committed to git — the NVIDIA-autoresearch
pattern. The ledger is the source of truth for campaign accounting: what ran,
under which config and data snapshot, what the locked harness scored, what it
cost, and the keep/discard verdict.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

LEDGER_PATH = Path(__file__).resolve().parents[3] / "experiments" / "ledger.jsonl"


@dataclass(slots=True)
class LedgerEntry:
    run_id: str
    campaign: str
    hypothesis: str
    model: str
    config_hash: str
    data_manifest_hash: str
    metrics: dict = field(default_factory=dict)
    gpu_seconds: float = 0.0
    cost_usd: float = 0.0
    verdict: str = "pending"  # pending | keep | discard | crashed
    notes: str = ""
    created_at: str = ""


def config_hash(config: dict) -> str:
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def append(entry: LedgerEntry, ledger_path: Path = LEDGER_PATH) -> None:
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    record = asdict(entry)
    if not record["created_at"]:
        record["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(ledger_path, "a") as f:
        f.write(json.dumps(record) + "\n")


def read_all(ledger_path: Path = LEDGER_PATH) -> list[dict]:
    if not ledger_path.is_file():
        return []
    return [json.loads(line) for line in ledger_path.read_text().splitlines() if line]


def campaign_cost(campaign: str, ledger_path: Path = LEDGER_PATH) -> float:
    return sum(
        e.get("cost_usd", 0.0) for e in read_all(ledger_path) if e.get("campaign") == campaign
    )
