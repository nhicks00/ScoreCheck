from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import json
import unittest

from vision_scoring.readiness import ManifestValidator, load_manifest


EXAMPLE = Path(__file__).parents[1] / "examples" / "readiness-manifest.json"


class ReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self.validator = ManifestValidator()

    def test_example_manifest_is_ready(self) -> None:
        report = self.validator.validate(self.manifest)
        self.assertTrue(report.ready, report.to_dict())
        serialized = json.dumps(report.to_dict())
        self.assertIn('"ready": true', serialized)

    def test_unknown_rights_are_a_blocker(self) -> None:
        self.manifest["data_sources"][0]["rights_status"] = "UNKNOWN"
        report = self.validator.validate(self.manifest)
        self.assertFalse(report.ready)
        self.assertIn("SOURCE_RIGHTS", {issue.code for issue in report.blockers})

    def test_match_and_unseen_venue_leakage_are_blockers(self) -> None:
        self.manifest["data_sources"][2]["match_id"] = self.manifest["data_sources"][0]["match_id"]
        self.manifest["data_sources"][2]["venue_id"] = self.manifest["data_sources"][0]["venue_id"]
        report = self.validator.validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("MATCH_LEAKAGE", codes)
        self.assertIn("VENUE_LEAKAGE", codes)

    def test_capture_pixel_and_timestamp_failures_block_training(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["far_ball_processed_pixels_p10"] = 4.0
        capture["timestamp_regressions"] = 1
        report = self.validator.validate(self.manifest)
        paths = {issue.path for issue in report.blockers}
        self.assertIn("capture_profiles[0].far_ball_processed_pixels_p10", paths)
        self.assertIn("capture_profiles[0].timestamp_regressions", paths)

    def test_dual_view_requires_measured_exposure_sync(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["mode"] = "DUAL_4K60"
        capture["camera_count"] = 2
        report = self.validator.validate(self.manifest)
        self.assertIn("EXPOSURE_SYNC", {issue.code for issue in report.blockers})
        capture["exposure_sync_p95_ms"] = 0.8
        self.assertTrue(self.validator.validate(self.manifest).ready)

    def test_source_must_reference_capture_and_keep_split_group_together(self) -> None:
        self.manifest["data_sources"][0]["capture_profile_id"] = "missing-profile"
        self.manifest["data_sources"][2]["split_group_id"] = self.manifest["data_sources"][1][
            "split_group_id"
        ]
        report = self.validator.validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("CAPTURE_PROFILE_REFERENCE", codes)
        self.assertIn("GROUP_LEAKAGE", codes)

    def test_1080p_profile_is_ready_only_as_warned_compatibility_mode(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture.update(
            {
                "mode": "1080P30",
                "width": 1920,
                "height": 1080,
                "fps": 30.0,
                "shutter_reciprocal": 600.0,
                "far_ball_processed_pixels_p10": 7.0,
            }
        )
        report = self.validator.validate(self.manifest)
        self.assertTrue(report.ready)
        self.assertIn("COMPATIBILITY_CAPTURE", {issue.code for issue in report.warnings})

    def test_unknown_fields_and_non_boolean_policy_fail_closed(self) -> None:
        self.manifest["capture_profiles"][0]["far_ball_processed_pixel_p10"] = 11.0
        self.manifest["policies"]["require_unseen_test_venue"] = "yes"
        report = self.validator.validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("UNKNOWN_FIELD", codes)
        self.assertIn("POLICY_SHAPE", codes)

    def test_capture_ratios_must_be_finite_probabilities(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["human_resolvable_visible_ball_ratio"] = float("nan")
        capture["visible_serve_frames_meeting_pixel_gate_ratio"] = 1.01
        report = self.validator.validate(self.manifest)
        blocked_paths = {issue.path for issue in report.blockers}
        self.assertIn("capture_profiles[0].human_resolvable_visible_ball_ratio", blocked_paths)
        self.assertIn(
            "capture_profiles[0].visible_serve_frames_meeting_pixel_gate_ratio",
            blocked_paths,
        )

    def test_boolean_values_do_not_satisfy_numeric_zero_gates(self) -> None:
        self.manifest["capture_profiles"][0]["timestamp_regressions"] = False
        report = self.validator.validate(self.manifest)
        self.assertIn(
            "capture_profiles[0].timestamp_regressions",
            {issue.path for issue in report.blockers},
        )


if __name__ == "__main__":
    unittest.main()
