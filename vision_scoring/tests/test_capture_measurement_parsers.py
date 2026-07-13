from __future__ import annotations

from copy import deepcopy
import json
import unittest

from vision_scoring.capture_contracts import MAX_FINALIZED_FRAMES
from vision_scoring.capture_measurement_parsers import (
    MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES,
    MAX_CAPTURE_MEASUREMENT_PACKETS,
    MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
    ParsedPresentationMetadataV1,
    parse_capture_measurement_presentation_metadata_v1,
    parse_capture_measurement_rgb24_framehash_v1,
    parse_capture_measurement_selected_video_packets_v1,
)
from vision_scoring.capture_measurement_rows import DecodedFrameInterlaceFactV1
from vision_scoring.capture_profile_contracts import VideoCodecV1
from vision_scoring.contract_wire import MIN_SIGNED_64


_MATRIX = (
    "\n00000000:            0      -65536           0\n"
    "00000001:        65536           0           0\n"
    "00000002:            0           0  1073741824\n"
)
_H264_PTS = (101, 137, 191, 263, 401)
_H264_DURATIONS = (36, 36, 54, 54, 40)
_H264_DIGESTS = (
    "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
    "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
    "a5a6f7dfe209d33573f50639c5e5de3e8f1ecdfdd7ee3394de90f144477abac3",
    "012fc7378dac7415516d97682d4ee6eeef0f9878a340c6cba7f0319a21534e1b",
    "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
)


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("ascii")


def _metadata_document(
    *,
    codec: str = "h264",
    stream: int = 2,
    width: int = 16,
    height: int = 12,
    pts: tuple[int | None, ...] = _H264_PTS,
    durations: tuple[int, ...] = _H264_DURATIONS,
    rotation: int | None = 90,
    interlaced: int = 0,
    sample_aspect_ratio: str = "1:1",
) -> dict[str, object]:
    frames: list[dict[str, object]] = []
    for ordinal, value in enumerate(pts):
        frame: dict[str, object] = {
            "media_type": "video",
            "stream_index": stream,
            "duration": durations[ordinal],
            "pkt_pos": str(4_261 + ordinal),
            "pkt_size": str(20 + ordinal),
            "width": width,
            "height": height,
            "sample_aspect_ratio": sample_aspect_ratio,
            "pix_fmt": "yuv420p10" if codec == "hevc" else "yuv420p",
            "interlaced_frame": interlaced,
            "top_field_first": int(bool(interlaced)),
            "repeat_pict": 0,
        }
        if value is not None:
            frame["pts"] = value
            if ordinal < 3:
                frame["pkt_dts"] = value
        if rotation is not None:
            frame["side_data_list"] = [
                {
                    "side_data_type": "3x3 displaymatrix",
                    "displaymatrix": _MATRIX,
                    "rotation": rotation,
                }
            ]
            if ordinal == 0:
                frame["side_data_list"].append(  # type: ignore[union-attr]
                    {"side_data_type": ("H.26[45] User Data Unregistered SEI message")}
                )
        frames.append(frame)
    selected: dict[str, object] = {
        "index": stream,
        "codec_name": codec,
        "codec_type": "video",
        "width": width,
        "height": height,
        "field_order": "tt" if interlaced else "progressive",
        "sample_aspect_ratio": sample_aspect_ratio,
        "time_base": "1/1000",
    }
    if rotation is not None:
        selected["side_data_list"] = [{"rotation": rotation}]
    return {
        "frames": frames,
        "programs": [],
        "stream_groups": [],
        "streams": [selected],
    }


def _packet_document(*, stream: int = 2) -> dict[str, object]:
    packet_pts = (101, 263, 137, 191, 401)
    packet_dts = (11, 47, 101, 137, 191)
    sizes = (712, 93, 14, 42, 20)
    packets = [
        {
            "stream_index": stream,
            "pts": pts,
            "dts": dts,
            "duration": 36,
            "size": str(size),
            "pos": str(4_261 + ordinal),
            "flags": "K__" if ordinal == 0 else "___",
        }
        for ordinal, (pts, dts, size) in enumerate(
            zip(packet_pts, packet_dts, sizes, strict=True)
        )
    ]
    return {
        "packets": packets,
        "programs": [],
        "stream_groups": [],
        "streams": [
            {
                "index": stream,
                "codec_type": "video",
                "time_base": "1/1000",
                "side_data_list": [
                    {
                        "side_data_type": "Display Matrix",
                        "displaymatrix": _MATRIX,
                        "rotation": 90,
                    }
                ],
            }
        ],
    }


def _framehash(
    *,
    pts: tuple[int | None, ...] = _H264_PTS,
    durations: tuple[int, ...] = _H264_DURATIONS,
    digests: tuple[str, ...] = _H264_DIGESTS,
    width: int = 16,
    height: int = 12,
    time_base: str = "1/1000",
    sample_aspect_ratio: str = "1/1",
) -> bytes:
    rows = []
    for value, duration, digest in zip(pts, durations, digests, strict=True):
        rendered_pts = MIN_SIGNED_64 if value is None else value
        rows.append(
            f"0,        {rendered_pts},        {rendered_pts},       "
            f"{duration},      {width * height * 3}, {digest}"
        )
    lines = [
        "#format: frame checksums",
        "#version: 2",
        "#hash: SHA256",
        "#software: Lavf62.12.100",
        f"#tb 0: {time_base}",
        "#media_type 0: video",
        "#codec_id 0: rawvideo",
        f"#dimensions 0: {width}x{height}",
        f"#sar 0: {sample_aspect_ratio}",
        "#stream#, dts,        pts, duration,     size, hash",
        *rows,
    ]
    return ("\n".join(lines) + "\n").encode("ascii")


class CaptureMeasurementParserTests(unittest.TestCase):
    def test_parser_accepts_exact_segment_caps_and_rejects_cap_plus_one(self) -> None:
        def metadata_document(frame_count: int) -> dict[str, object]:
            return {
                "frames": [
                    {
                        "height": 12,
                        "interlaced_frame": 0,
                        "media_type": "video",
                        "pix_fmt": "yuv420p",
                        "pts": ordinal,
                        "repeat_pict": 0,
                        "sample_aspect_ratio": "1:1",
                        "stream_index": 2,
                        "top_field_first": 0,
                        "width": 16,
                    }
                    for ordinal in range(frame_count)
                ],
                "programs": [],
                "stream_groups": [],
                "streams": [
                    {
                        "codec_name": "h264",
                        "codec_type": "video",
                        "field_order": "progressive",
                        "height": 12,
                        "index": 2,
                        "sample_aspect_ratio": "1:1",
                        "time_base": "1/1000",
                        "width": 16,
                    }
                ],
            }

        at_frame_cap = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(metadata_document(MAX_FINALIZED_FRAMES)),
            selected_video_stream_index=2,
        )
        self.assertEqual(at_frame_cap.frame_count, MAX_FINALIZED_FRAMES)
        with self.assertRaisesRegex(ValueError, "finalized-segment limit"):
            parse_capture_measurement_presentation_metadata_v1(
                _json_bytes(metadata_document(MAX_FINALIZED_FRAMES + 1)),
                selected_video_stream_index=2,
            )

        def packet_document(packet_count: int) -> dict[str, object]:
            return {
                "packets": [
                    {"flags": "___", "size": "1", "stream_index": 2}
                    for _ in range(packet_count)
                ],
                "programs": [],
                "stream_groups": [],
                "streams": [{"codec_type": "video", "index": 2, "time_base": "1/1000"}],
            }

        at_packet_cap = parse_capture_measurement_selected_video_packets_v1(
            _json_bytes(packet_document(MAX_CAPTURE_MEASUREMENT_PACKETS)),
            selected_video_stream_index=2,
        )
        self.assertEqual(len(at_packet_cap), MAX_CAPTURE_MEASUREMENT_PACKETS)
        with self.assertRaisesRegex(ValueError, "bounded finalized-segment limit"):
            parse_capture_measurement_selected_video_packets_v1(
                _json_bytes(packet_document(MAX_CAPTURE_MEASUREMENT_PACKETS + 1)),
                selected_video_stream_index=2,
            )

    def test_h264_fixture_semantics_join_presentation_not_packet_dts(self) -> None:
        metadata = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(_metadata_document()), selected_video_stream_index=2
        )
        packets = parse_capture_measurement_selected_video_packets_v1(
            _json_bytes(_packet_document()), selected_video_stream_index=2
        )
        decoded = parse_capture_measurement_rgb24_framehash_v1(
            _framehash(), metadata=metadata
        )

        self.assertIs(metadata.observed_codec, VideoCodecV1.AVC_H264)
        self.assertEqual(metadata.display_rotation_degrees, 90)
        self.assertEqual(
            tuple(row.presentation_pts for row in metadata.presentation_timing_rows),
            _H264_PTS,
        )
        self.assertEqual(
            tuple(row.packet_pts for row in packets), (101, 263, 137, 191, 401)
        )
        self.assertEqual(
            tuple(row.packet_dts for row in packets), (11, 47, 101, 137, 191)
        )
        self.assertEqual(tuple(row.presentation_pts for row in decoded), _H264_PTS)
        self.assertEqual(
            tuple(row.decoded_pixel_sha256 for row in decoded), _H264_DIGESTS
        )
        self.assertTrue(
            all(
                row.interlace_fact is DecodedFrameInterlaceFactV1.PROGRESSIVE
                for row in decoded
            )
        )
        for row in (*metadata.presentation_timing_rows, *packets, *decoded):
            self.assertFalse(row.admissible_for_training)
            self.assertFalse(row.admissible_for_live_scoring)

    def test_hevc_interlaced_and_missing_pts_are_preserved_per_frame(self) -> None:
        pts = (103, None, 211)
        metadata = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(
                _metadata_document(
                    codec="hevc",
                    stream=0,
                    width=64,
                    height=64,
                    pts=pts,
                    durations=(46, 62, 40),
                    rotation=None,
                    interlaced=1,
                )
            ),
            selected_video_stream_index=0,
        )
        digests = ("1" * 64, "2" * 64, "3" * 64)
        decoded = parse_capture_measurement_rgb24_framehash_v1(
            _framehash(
                pts=pts,
                durations=(46, 62, 40),
                digests=digests,
                width=64,
                height=64,
            ),
            metadata=metadata,
        )
        self.assertIs(metadata.observed_codec, VideoCodecV1.HEVC_H265)
        self.assertEqual(metadata.display_rotation_degrees, 0)
        self.assertEqual(
            metadata.frame_interlace_facts,
            (DecodedFrameInterlaceFactV1.INTERLACED,) * 3,
        )
        self.assertEqual(tuple(row.presentation_pts for row in decoded), pts)

    def test_metadata_rejects_wrong_or_ambiguous_stream_selection(self) -> None:
        base = _metadata_document()
        variants = []
        audio = deepcopy(base)
        audio["streams"][0]["codec_type"] = "audio"  # type: ignore[index]
        variants.append(audio)
        nonexistent = deepcopy(base)
        nonexistent["streams"][0]["index"] = 9  # type: ignore[index]
        variants.append(nonexistent)
        duplicate = deepcopy(base)
        duplicate["streams"].append(deepcopy(duplicate["streams"][0]))  # type: ignore[union-attr,index]
        variants.append(duplicate)
        missing = deepcopy(base)
        missing["streams"] = []
        variants.append(missing)
        extra = deepcopy(base)
        extra["streams"][0]["path"] = "/private/source.mp4"  # type: ignore[index]
        variants.append(extra)
        unsupported_codec = deepcopy(base)
        unsupported_codec["streams"][0]["codec_name"] = "prores"  # type: ignore[index]
        variants.append(unsupported_codec)
        for document in variants:
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    parse_capture_measurement_presentation_metadata_v1(
                        _json_bytes(document), selected_video_stream_index=2
                    )

    def test_metadata_rejects_media_geometry_interlace_and_rotation_changes(
        self,
    ) -> None:
        base = _metadata_document()
        variants = []
        media = deepcopy(base)
        media["frames"][1]["media_type"] = "audio"  # type: ignore[index]
        variants.append(media)
        geometry = deepcopy(base)
        geometry["frames"][1]["width"] = 17  # type: ignore[index]
        variants.append(geometry)
        interlace = deepcopy(base)
        interlace["frames"][1]["interlaced_frame"] = 1  # type: ignore[index]
        interlace["frames"][1]["top_field_first"] = 1  # type: ignore[index]
        variants.append(interlace)
        rotation = deepcopy(base)
        rotation["frames"][1]["side_data_list"][0]["rotation"] = -90  # type: ignore[index]
        variants.append(rotation)
        duplicate_rotation = deepcopy(base)
        duplicate_rotation["streams"][0]["side_data_list"].append(  # type: ignore[index,union-attr]
            {"rotation": 90}
        )
        variants.append(duplicate_rotation)
        pix_fmt = deepcopy(base)
        pix_fmt["frames"][1]["pix_fmt"] = "yuv444p"  # type: ignore[index]
        variants.append(pix_fmt)
        for document in variants:
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    parse_capture_measurement_presentation_metadata_v1(
                        _json_bytes(document), selected_video_stream_index=2
                    )

    def test_json_protocol_rejects_hostile_encodings_numbers_and_structures(
        self,
    ) -> None:
        valid = _json_bytes(_metadata_document())
        duplicate = valid.replace(b'"frames":', b'"frames":[],"frames":', 1)
        huge_int = valid.replace(b'"index":2', b'"index":999999999999999999999', 1)
        float_int = valid.replace(b'"index":2', b'"index":2.0', 1)
        non_ascii = valid.replace(b"yuv420p", "yuvé420p".encode("utf-8"), 1)
        nested = b'{"frames":' + b"[" * 9 + b"]" * 9 + b"}"
        malformed_utf8 = valid[:-1] + b"\xff"
        oversized = b" " * (MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES + 1)
        for raw in (
            duplicate,
            huge_int,
            float_int,
            non_ascii,
            nested,
            malformed_utf8,
            oversized,
            b"",
        ):
            with self.subTest(raw=raw[:80]):
                with self.assertRaises((UnicodeDecodeError, ValueError)):
                    parse_capture_measurement_presentation_metadata_v1(
                        raw, selected_video_stream_index=2
                    )

    def test_packet_parser_is_independent_strict_and_preserves_missing_timestamps(
        self,
    ) -> None:
        document = _packet_document()
        del document["packets"][1]["pts"]  # type: ignore[index]
        del document["packets"][2]["dts"]  # type: ignore[index]
        rows = parse_capture_measurement_selected_video_packets_v1(
            _json_bytes(document), selected_video_stream_index=2
        )
        self.assertIsNone(rows[1].packet_pts)
        self.assertIsNone(rows[2].packet_dts)
        self.assertEqual(tuple(row.packet_ordinal for row in rows), tuple(range(5)))
        self.assertEqual(
            tuple(row.payload_byte_length for row in rows), (712, 93, 14, 42, 20)
        )

        variants = []
        empty = _packet_document()
        empty["packets"] = []
        variants.append(empty)
        audio = _packet_document()
        audio["streams"][0]["codec_type"] = "audio"  # type: ignore[index]
        variants.append(audio)
        wrong_stream = _packet_document()
        wrong_stream["packets"][1]["stream_index"] = 1  # type: ignore[index]
        variants.append(wrong_stream)
        zero = _packet_document()
        zero["packets"][0]["size"] = "0"  # type: ignore[index]
        variants.append(zero)
        number_size = _packet_document()
        number_size["packets"][0]["size"] = 712  # type: ignore[index]
        variants.append(number_size)
        extra = _packet_document()
        extra["packets"][0]["codec_type"] = "video"  # type: ignore[index]
        variants.append(extra)
        duplicate_stream = _packet_document()
        duplicate_stream["streams"].append(duplicate_stream["streams"][0])  # type: ignore[union-attr,index]
        variants.append(duplicate_stream)
        for variant in variants:
            with self.subTest(variant=variant):
                with self.assertRaises(ValueError):
                    parse_capture_measurement_selected_video_packets_v1(
                        _json_bytes(variant), selected_video_stream_index=2
                    )

    def test_framehash_rejects_every_binding_and_row_count_mismatch(self) -> None:
        metadata = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(_metadata_document()), selected_video_stream_index=2
        )
        valid = _framehash()
        variants = (
            valid.replace(b"#tb 0: 1/1000", b"#tb 0: 1/90000"),
            valid.replace(b"#dimensions 0: 16x12", b"#dimensions 0: 12x16"),
            valid.replace(b"#media_type 0: video", b"#media_type 0: audio"),
            valid.replace(b"#codec_id 0: rawvideo", b"#codec_id 0: h264"),
            valid.replace(b",        137,        137,", b",        138,        138,"),
            valid.replace(b",      576,", b",      575,", 1),
            valid.replace(_H264_DIGESTS[0].encode(), b"A" * 64, 1),
            valid.replace(b"0,        101", b"1,        101", 1),
            valid.replace(b"\n", b"\r\n"),
            valid[:-1],
            valid + valid.splitlines(keepends=True)[-1],
            b"\n".join(valid.splitlines()[:-1]) + b"\n",
            b" " * (MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES + 1),
        )
        for raw in variants:
            with self.subTest(raw=raw[:100]):
                with self.assertRaises((UnicodeDecodeError, ValueError)):
                    parse_capture_measurement_rgb24_framehash_v1(raw, metadata=metadata)

    def test_mpeg_ts_program_metadata_and_ignored_unicode_are_bounded_not_denied(
        self,
    ) -> None:
        metadata_document = _metadata_document()
        metadata_document["programs"] = [
            {
                "program_num": 1,
                "streams": [{"index": 2, "ignored_label": "Cámara principal 🏐"}],
            }
        ]
        metadata_document["stream_groups"] = [
            {"ignored_group_label": "Cancha número uno"}
        ]
        metadata = parse_capture_measurement_presentation_metadata_v1(
            json.dumps(metadata_document, separators=(",", ":")).encode("utf-8"),
            selected_video_stream_index=2,
        )
        self.assertEqual(metadata.frame_count, len(_H264_PTS))

        packet_document = _packet_document()
        packet_document["programs"] = metadata_document["programs"]
        packet_document["stream_groups"] = metadata_document["stream_groups"]
        for packet in packet_document["packets"]:  # type: ignore[union-attr]
            packet["side_data_list"] = [  # type: ignore[index]
                {"side_data_type": "MPEGTS Stream ID", "id": 224}
            ]
        packets = parse_capture_measurement_selected_video_packets_v1(
            json.dumps(packet_document, separators=(",", ":")).encode("utf-8"),
            selected_video_stream_index=2,
        )
        self.assertEqual(len(packets), 5)

    def test_sample_aspect_ratio_is_stable_and_bound_to_framehash(self) -> None:
        metadata = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(_metadata_document(sample_aspect_ratio="2:1")),
            selected_video_stream_index=2,
        )
        self.assertEqual(
            (
                metadata.sample_aspect_ratio_numerator,
                metadata.sample_aspect_ratio_denominator,
            ),
            (2, 1),
        )
        decoded = parse_capture_measurement_rgb24_framehash_v1(
            _framehash(sample_aspect_ratio="2/1"), metadata=metadata
        )
        self.assertTrue(
            all(
                (
                    row.sample_aspect_ratio_numerator,
                    row.sample_aspect_ratio_denominator,
                )
                == (2, 1)
                for row in decoded
            )
        )
        with self.assertRaisesRegex(ValueError, "terminal headers"):
            parse_capture_measurement_rgb24_framehash_v1(
                _framehash(sample_aspect_ratio="1/1"), metadata=metadata
            )

        changed = _metadata_document(sample_aspect_ratio="2:1")
        changed["frames"][1]["sample_aspect_ratio"] = "1:1"  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "sample aspect ratio changed"):
            parse_capture_measurement_presentation_metadata_v1(
                _json_bytes(changed), selected_video_stream_index=2
            )
        for invalid in ("2:2", "0:1", "N/A", "2/1"):
            malformed = _metadata_document(sample_aspect_ratio=invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                parse_capture_measurement_presentation_metadata_v1(
                    _json_bytes(malformed), selected_video_stream_index=2
                )

    def test_mutated_structural_metadata_cannot_authorize_frame_rows(self) -> None:
        metadata = parse_capture_measurement_presentation_metadata_v1(
            _json_bytes(_metadata_document()), selected_video_stream_index=2
        )
        object.__setattr__(metadata, "admissible_for_training", True)
        with self.assertRaisesRegex(ValueError, "exactly false"):
            parse_capture_measurement_rgb24_framehash_v1(
                _framehash(), metadata=metadata
            )
        with self.assertRaises(ValueError):
            ParsedPresentationMetadataV1(
                observed_codec=VideoCodecV1.AVC_H264,
                selected_video_stream_index=2,
                source_time_base_numerator=2,
                source_time_base_denominator=2_000,
                decoded_width_px=16,
                decoded_height_px=12,
                sample_aspect_ratio_numerator=1,
                sample_aspect_ratio_denominator=1,
                display_rotation_degrees=90,
                presentation_timing_rows=metadata.presentation_timing_rows,
                frame_interlace_facts=metadata.frame_interlace_facts,
            )


if __name__ == "__main__":
    unittest.main()
