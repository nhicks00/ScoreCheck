from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import hashlib
import json
import unittest

from vision_scoring.dataset_split import (
    DatasetSplit,
    MAX_SPLIT_IDENTIFIER_LENGTH,
    MAX_SPLIT_RECORDS,
    SourceSplitRecord,
    SplitContractError,
    SplitManifest,
)


def _sha(character: str) -> str:
    return character * 64


def _indexed_sha(index: int) -> str:
    return f"{index:064x}"


def _record(
    hash_character: str,
    split: DatasetSplit,
    *,
    match_id: str,
    venue_id: str,
    camera_setup_id: str,
    recording_date: str,
    synchronized_capture_group_id: str,
    split_group_id: str,
    root_hash_character: str | None = None,
    parent_hash_character: str | None = None,
) -> SourceSplitRecord:
    return SourceSplitRecord(
        asset_sha256=_sha(hash_character),
        root_asset_sha256=_sha(root_hash_character or hash_character),
        parent_asset_sha256=(
            _sha(parent_hash_character) if parent_hash_character is not None else None
        ),
        match_id=match_id,
        venue_id=venue_id,
        camera_setup_id=camera_setup_id,
        recording_date=recording_date,
        synchronized_capture_group_id=synchronized_capture_group_id,
        split_group_id=split_group_id,
        split=split,
    )


def _valid_records() -> tuple[SourceSplitRecord, ...]:
    return (
        _record(
            "a",
            DatasetSplit.TRAIN,
            match_id="match-train",
            venue_id="venue-train",
            camera_setup_id="camera-train-a",
            recording_date="2026-07-01",
            synchronized_capture_group_id="sync-train",
            split_group_id="venue-train-camera-a-2026-07-01",
        ),
        _record(
            "b",
            DatasetSplit.TRAIN,
            match_id="match-train",
            venue_id="venue-train",
            camera_setup_id="camera-train-b",
            recording_date="2026-07-01",
            synchronized_capture_group_id="sync-train",
            split_group_id="venue-train-camera-b-2026-07-01",
        ),
        _record(
            "c",
            DatasetSplit.DEV,
            match_id="match-dev",
            venue_id="venue-dev",
            camera_setup_id="camera-dev",
            recording_date="2026-07-02",
            synchronized_capture_group_id="sync-dev",
            split_group_id="venue-dev-camera-2026-07-02",
        ),
        _record(
            "d",
            DatasetSplit.TEST,
            match_id="match-test",
            venue_id="venue-test",
            camera_setup_id="camera-test",
            recording_date="2026-07-03",
            synchronized_capture_group_id="sync-test",
            split_group_id="venue-test-camera-2026-07-03",
        ),
    )


def _derived(
    hash_character: str,
    *,
    parent_hash_character: str,
    split: DatasetSplit = DatasetSplit.TRAIN,
) -> SourceSplitRecord:
    return _record(
        hash_character,
        split,
        root_hash_character="a",
        parent_hash_character=parent_hash_character,
        match_id="match-train",
        venue_id="venue-train",
        camera_setup_id="camera-train-a",
        recording_date="2026-07-01",
        synchronized_capture_group_id="sync-train",
        split_group_id="venue-train-camera-a-2026-07-01",
    )


def _independent_record(index: int) -> SourceSplitRecord:
    split = tuple(DatasetSplit)[index % len(DatasetSplit)]
    asset_sha256 = _indexed_sha(index + 1)
    return SourceSplitRecord(
        asset_sha256=asset_sha256,
        root_asset_sha256=asset_sha256,
        parent_asset_sha256=None,
        match_id=f"match-{index}",
        venue_id=f"venue-{index}",
        camera_setup_id=f"camera-{index}",
        recording_date="2026-07-01",
        synchronized_capture_group_id=f"sync-{index}",
        split_group_id=f"group-{index}",
        split=split,
    )


class DatasetSplitTests(unittest.TestCase):
    def test_valid_manifest_preserves_multiple_cameras_for_one_match(self) -> None:
        manifest = SplitManifest(_valid_records())

        same_match = [record for record in manifest.records if record.match_id == "match-train"]
        self.assertEqual(
            {record.camera_setup_id for record in same_match},
            {"camera-train-a", "camera-train-b"},
        )
        self.assertEqual({record.split for record in same_match}, {DatasetSplit.TRAIN})

    def test_parent_and_multigeneration_derivatives_are_valid_in_one_split(self) -> None:
        child = _derived("e", parent_hash_character="a")
        grandchild = _derived("f", parent_hash_character="e")

        manifest = SplitManifest((*_valid_records(), child, grandchild))

        family = [
            record for record in manifest.records if record.root_asset_sha256 == _sha("a")
        ]
        self.assertEqual(len(family), 3)
        self.assertEqual({record.split for record in family}, {DatasetSplit.TRAIN})

    def test_all_three_splits_are_required(self) -> None:
        records = _valid_records()
        with self.assertRaisesRegex(SplitContractError, "missing: DEV") as caught:
            SplitManifest(tuple(record for record in records if record.split is not DatasetSplit.DEV))
        self.assertEqual(caught.exception.code, "SPLIT_MISSING_PARTITION")

    def test_duplicate_assets_are_rejected(self) -> None:
        records = list(_valid_records())
        records[2] = replace(
            records[2],
            asset_sha256=records[0].asset_sha256,
            root_asset_sha256=records[0].root_asset_sha256,
        )
        with self.assertRaisesRegex(SplitContractError, "duplicate asset_sha256") as caught:
            SplitManifest(tuple(records))
        self.assertEqual(caught.exception.code, "SPLIT_DUPLICATE_ASSET")

    def test_root_records_require_self_root_and_null_parent(self) -> None:
        root = _valid_records()[0]
        with self.assertRaisesRegex(ValueError, "asset_sha256 equal"):
            replace(root, root_asset_sha256=_sha("f"))
        with self.assertRaisesRegex(ValueError, "parent_asset_sha256 null"):
            replace(root, parent_asset_sha256=_sha("b"))

    def test_missing_parent_or_root_is_an_orphan(self) -> None:
        missing_parent = _derived("e", parent_hash_character="f")
        with self.assertRaisesRegex(SplitContractError, "missing parent asset") as caught:
            SplitManifest((*_valid_records(), missing_parent))
        self.assertEqual(caught.exception.code, "SPLIT_LINEAGE_ORPHAN")

        missing_root = replace(
            missing_parent,
            root_asset_sha256=_sha("f"),
            parent_asset_sha256=_sha("a"),
        )
        with self.assertRaisesRegex(SplitContractError, "missing root asset"):
            SplitManifest((*_valid_records(), missing_root))

    def test_parent_and_child_must_declare_the_same_root(self) -> None:
        child = replace(
            _derived("e", parent_hash_character="a"),
            root_asset_sha256=_sha("c"),
        )
        with self.assertRaisesRegex(SplitContractError, "declare different roots") as caught:
            SplitManifest((*_valid_records(), child))
        self.assertEqual(caught.exception.code, "SPLIT_LINEAGE_ROOT_MISMATCH")

    def test_lineage_cycles_are_rejected(self) -> None:
        first = _derived("e", parent_hash_character="f")
        second = _derived("f", parent_hash_character="e")
        with self.assertRaisesRegex(SplitContractError, "contains a cycle") as caught:
            SplitManifest((*_valid_records(), first, second))
        self.assertEqual(caught.exception.code, "SPLIT_LINEAGE_CYCLE")

    def test_lineage_validation_handles_more_than_1200_generations_iteratively(self) -> None:
        root = _valid_records()[0]
        records = [*_valid_records()]
        parent_sha256 = root.asset_sha256
        depth = 1_205
        for index in range(depth):
            # Descending hashes make the deepest leaf lexicographically first.
            # A recursive validator therefore deterministically exceeds Python's
            # recursion limit instead of relying on a favorable traversal order.
            asset_sha256 = _indexed_sha(depth - index)
            records.append(
                SourceSplitRecord(
                    asset_sha256=asset_sha256,
                    root_asset_sha256=root.asset_sha256,
                    parent_asset_sha256=parent_sha256,
                    match_id=root.match_id,
                    venue_id=root.venue_id,
                    camera_setup_id=root.camera_setup_id,
                    recording_date=root.recording_date,
                    synchronized_capture_group_id=root.synchronized_capture_group_id,
                    split_group_id=root.split_group_id,
                    split=root.split,
                )
            )
            parent_sha256 = asset_sha256

        manifest = SplitManifest(tuple(records))

        self.assertEqual(len(manifest.records), len(_valid_records()) + depth)

    def test_deep_cycle_rejection_is_deterministic_and_message_bounded(self) -> None:
        root = _valid_records()[0]
        depth = 1_205
        asset_hashes = tuple(_indexed_sha(index + 1) for index in range(depth))
        cycle_records = tuple(
            SourceSplitRecord(
                asset_sha256=asset_sha256,
                root_asset_sha256=root.asset_sha256,
                parent_asset_sha256=asset_hashes[(index + 1) % depth],
                match_id=root.match_id,
                venue_id=root.venue_id,
                camera_setup_id=root.camera_setup_id,
                recording_date=root.recording_date,
                synchronized_capture_group_id=root.synchronized_capture_group_id,
                split_group_id=root.split_group_id,
                split=root.split,
            )
            for index, asset_sha256 in enumerate(asset_hashes)
        )
        records = (*_valid_records(), *cycle_records)

        messages: list[str] = []
        for ordering in (records, tuple(reversed(records))):
            with self.assertRaises(SplitContractError) as caught:
                SplitManifest(ordering)
            self.assertEqual(caught.exception.code, "SPLIT_LINEAGE_CYCLE")
            messages.append(str(caught.exception))

        self.assertEqual(messages[0], messages[1])
        self.assertIn(f"length={depth}", messages[0])
        self.assertLess(len(messages[0]), 1_024)

    def test_lineage_edges_cannot_cross_splits(self) -> None:
        child = _derived(
            "e",
            parent_hash_character="a",
            split=DatasetSplit.DEV,
        )
        with self.assertRaisesRegex(SplitContractError, "lineage edge") as caught:
            SplitManifest((*_valid_records(), child))
        self.assertEqual(caught.exception.code, "SPLIT_LINEAGE_EDGE_LEAKAGE")

    def test_match_cannot_cross_splits(self) -> None:
        records = list(_valid_records())
        records[2] = replace(records[2], match_id=records[0].match_id)
        with self.assertRaisesRegex(SplitContractError, "cross-split match leakage") as caught:
            SplitManifest(tuple(records))
        self.assertEqual(caught.exception.code, "SPLIT_MATCH_LEAKAGE")

    def test_synchronized_views_cannot_cross_splits(self) -> None:
        records = list(_valid_records())
        records[2] = replace(
            records[2],
            synchronized_capture_group_id=records[0].synchronized_capture_group_id,
        )
        with self.assertRaisesRegex(SplitContractError, "synchronized capture group") as caught:
            SplitManifest(tuple(records))
        self.assertEqual(caught.exception.code, "SPLIT_SYNC_LEAKAGE")

    def test_declared_split_group_cannot_cross_splits(self) -> None:
        records = list(_valid_records())
        records[2] = replace(records[2], split_group_id=records[0].split_group_id)
        with self.assertRaisesRegex(SplitContractError, "declared split group") as caught:
            SplitManifest(tuple(records))
        self.assertEqual(caught.exception.code, "SPLIT_GROUP_LEAKAGE")

    def test_venue_camera_day_cannot_be_hidden_behind_different_group_ids(self) -> None:
        records = list(_valid_records())
        records[2] = replace(
            records[2],
            venue_id=records[0].venue_id,
            camera_setup_id=records[0].camera_setup_id,
            recording_date=records[0].recording_date,
            split_group_id="deliberately-different-group-id",
        )
        with self.assertRaisesRegex(SplitContractError, "venue-camera-day leakage") as caught:
            SplitManifest(tuple(records), require_unseen_test_venue=False)
        self.assertEqual(caught.exception.code, "SPLIT_VENUE_CAMERA_DAY_LEAKAGE")

    def test_test_venue_must_be_unseen_by_default(self) -> None:
        records = list(_valid_records())
        records[-1] = replace(
            records[-1],
            venue_id=records[0].venue_id,
            camera_setup_id="different-test-camera",
            recording_date="2026-07-04",
            split_group_id="test-same-venue-different-camera-day",
        )
        with self.assertRaisesRegex(SplitContractError, "TEST venues must be unseen") as caught:
            SplitManifest(tuple(records))
        self.assertEqual(caught.exception.code, "SPLIT_TEST_VENUE_LEAKAGE")

        manifest = SplitManifest(tuple(records), require_unseen_test_venue=False)
        self.assertFalse(manifest.require_unseen_test_venue)

    def test_raw_split_strings_are_rejected(self) -> None:
        values = _valid_records()[0].to_dict()
        with self.assertRaisesRegex(ValueError, "DatasetSplit enum"):
            SourceSplitRecord(**values)

    def test_every_source_field_is_required(self) -> None:
        values = _valid_records()[0].to_dict()
        values["split"] = DatasetSplit.TRAIN
        values.pop("match_id")
        with self.assertRaises(TypeError):
            SourceSplitRecord(**values)

    def test_asset_hashes_must_be_lowercase_sha256_or_null_parent(self) -> None:
        record = _valid_records()[0]
        for field_name in ("asset_sha256", "root_asset_sha256"):
            for invalid_hash in ("a" * 63, "A" * 64, "g" * 64, 7, True):
                with self.subTest(field_name=field_name, invalid_hash=invalid_hash):
                    with self.assertRaisesRegex(ValueError, field_name):
                        replace(record, **{field_name: invalid_hash})
        for invalid_parent in ("a" * 63, "A" * 64, 7, True):
            with self.subTest(invalid_parent=invalid_parent):
                with self.assertRaisesRegex(ValueError, "parent_asset_sha256"):
                    replace(_derived("e", parent_hash_character="a"), parent_asset_sha256=invalid_parent)

    def test_recording_date_is_a_strict_calendar_date(self) -> None:
        record = _valid_records()[0]
        for invalid_date in (
            "2026-02-30",
            "20260701",
            "2026-07-01T00:00:00",
            20260701,
            True,
        ):
            with self.subTest(invalid_date=invalid_date):
                with self.assertRaisesRegex(ValueError, "ISO-8601 calendar date"):
                    replace(record, recording_date=invalid_date)

    def test_every_identity_is_a_bounded_ascii_stable_identifier(self) -> None:
        record = _valid_records()[0]
        for field_name in (
            "match_id",
            "venue_id",
            "camera_setup_id",
            "synchronized_capture_group_id",
            "split_group_id",
        ):
            for invalid_value in (
                "",
                "   ",
                " padded",
                "padded ",
                "internal space",
                "line\nbreak",
                "control\x00character",
                "zero\u200bwidth",
                "caf\u00e9",
                "cafe\u0301",
                "a" * (MAX_SPLIT_IDENTIFIER_LENGTH + 1),
                7,
                True,
            ):
                with self.subTest(field_name=field_name, invalid_value=invalid_value):
                    with self.assertRaisesRegex(ValueError, f"{field_name}.*ASCII identifier"):
                        replace(record, **{field_name: invalid_value})

            bounded = replace(
                record,
                **{field_name: "a" * MAX_SPLIT_IDENTIFIER_LENGTH},
            )
            self.assertEqual(
                getattr(bounded, field_name),
                "a" * MAX_SPLIT_IDENTIFIER_LENGTH,
            )

    def test_manifest_record_limit_accepts_boundary_and_rejects_one_more(self) -> None:
        records = tuple(_independent_record(index) for index in range(MAX_SPLIT_RECORDS))

        manifest = SplitManifest(records)
        self.assertEqual(len(manifest.records), MAX_SPLIT_RECORDS)

        with self.assertRaisesRegex(
            SplitContractError,
            f"cannot exceed {MAX_SPLIT_RECORDS}",
        ) as caught:
            SplitManifest((*records, _independent_record(MAX_SPLIT_RECORDS)))
        self.assertEqual(caught.exception.code, "SPLIT_RECORD_LIMIT_EXCEEDED")

    def test_policy_requires_a_real_boolean_and_records_require_a_tuple(self) -> None:
        for invalid_policy in (0, 1, "true", None):
            with self.subTest(invalid_policy=invalid_policy):
                with self.assertRaisesRegex(ValueError, "must be a boolean"):
                    SplitManifest(_valid_records(), require_unseen_test_venue=invalid_policy)
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            SplitManifest(list(_valid_records()))

    def test_records_and_manifest_are_immutable_and_slotted(self) -> None:
        record = _valid_records()[0]
        manifest = SplitManifest(_valid_records())
        with self.assertRaises(FrozenInstanceError):
            record.match_id = "changed"
        with self.assertRaises(FrozenInstanceError):
            manifest.records = ()
        self.assertFalse(hasattr(record, "__dict__"))
        self.assertFalse(hasattr(manifest, "__dict__"))

    def test_canonical_json_and_fingerprint_are_order_independent(self) -> None:
        records = _valid_records()
        first = SplitManifest(records)
        reordered = SplitManifest(tuple(reversed(records)))

        self.assertEqual(first.canonical_json(), reordered.canonical_json())
        self.assertEqual(first.fingerprint(), reordered.fingerprint())
        self.assertEqual(
            first.fingerprint(),
            hashlib.sha256(first.canonical_json().encode("utf-8")).hexdigest(),
        )
        payload = json.loads(first.canonical_json())
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertEqual(
            [record["asset_sha256"] for record in payload["records"]],
            sorted(record.asset_sha256 for record in records),
        )
        self.assertNotIn("timestamp", first.canonical_json().lower())

    def test_material_changes_change_the_fingerprint(self) -> None:
        records = _valid_records()
        original = SplitManifest(records)
        changed_records = list(records)
        changed_records[0] = replace(changed_records[0], camera_setup_id="camera-train-a-v2")
        changed_records[0] = replace(
            changed_records[0],
            split_group_id="venue-train-camera-a-v2-2026-07-01",
        )
        changed = SplitManifest(tuple(changed_records))
        policy_changed = SplitManifest(records, require_unseen_test_venue=False)

        self.assertNotEqual(original.fingerprint(), changed.fingerprint())
        self.assertNotEqual(original.fingerprint(), policy_changed.fingerprint())
        self.assertRegex(original.fingerprint(), r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
