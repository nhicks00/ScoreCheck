"""Apple Vision OCR engine for scorebug reading (macOS only).

Wraps VNRecognizeTextRequest so callers pass numpy RGB frames and receive
plain token tuples. Coordinates are returned in top-left-origin normalized
form (x, y, w, h) relative to the input image.

Memory-safety note (incident 2026-07-14): the CGImage MUST be built from a
CFData-backed provider. ``CGDataProviderCreateWithData(None, bytes, ...)``
with a null release callback pins every frame's pixel buffer for the life of
the process under pyobjc — at 20 OCR calls/second that leaked tens of GB and
froze the machine. Measured: +122 MB per 500 calls before, +5 MB after.
"""

from __future__ import annotations

import os
import resource
from dataclasses import dataclass

import numpy as np

try:
    import objc
    import Quartz
    import Vision
except ModuleNotFoundError as error:  # pragma: no cover - non-macOS
    raise ModuleNotFoundError(
        "scorevision.ocr_apple requires macOS with pyobjc-framework-Vision"
    ) from error

# Hard ceiling: OCR is a bounded-memory workload; blowing past this means a
# leak has returned. Fail loudly instead of freezing the host.
_DEFAULT_RSS_LIMIT_MB = 4096
_RSS_CHECK_EVERY = 500
_rss_limit_mb = float(os.environ.get("SCOREVISION_RSS_LIMIT_MB", _DEFAULT_RSS_LIMIT_MB))
_calls_since_check = 0


class MemoryGuardExceeded(RuntimeError):
    """Raised when the process RSS exceeds the configured ceiling."""


def _check_memory_guard() -> None:
    global _calls_since_check
    _calls_since_check += 1
    if _calls_since_check < _RSS_CHECK_EVERY:
        return
    _calls_since_check = 0
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
    if rss_mb > _rss_limit_mb:
        raise MemoryGuardExceeded(
            f"process RSS {rss_mb:.0f} MB exceeds SCOREVISION_RSS_LIMIT_MB="
            f"{_rss_limit_mb:.0f}; aborting rather than exhausting the host"
        )


@dataclass(frozen=True, slots=True)
class OcrToken:
    text: str
    confidence: float
    x: float
    y: float
    width: float
    height: float

    @property
    def center_x(self) -> float:
        return self.x + self.width / 2.0

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2.0


def _cgimage_from_rgb(frame: np.ndarray):
    if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
        raise ValueError("frame must be HxWx3 uint8 RGB")
    frame = np.ascontiguousarray(frame)
    height, width, _ = frame.shape
    data = frame.tobytes()
    # CFData owns a copy with a proper CF lifecycle; see module docstring.
    cfdata = Quartz.CFDataCreate(None, data, len(data))
    provider = Quartz.CGDataProviderCreateWithCFData(cfdata)
    colorspace = Quartz.CGColorSpaceCreateDeviceRGB()
    return Quartz.CGImageCreate(
        width,
        height,
        8,
        24,
        width * 3,
        colorspace,
        Quartz.kCGImageAlphaNone,
        provider,
        None,
        False,
        Quartz.kCGRenderingIntentDefault,
    )


def recognize_text(frame: np.ndarray, *, fast: bool = False) -> list[OcrToken]:
    """OCR an RGB frame; returns tokens sorted top-to-bottom, left-to-right."""
    _check_memory_guard()
    collected: list[OcrToken] = []
    with objc.autorelease_pool():
        cg = _cgimage_from_rgb(frame)
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            cg, None
        )
        request = Vision.VNRecognizeTextRequest.alloc().init()
        level = (
            Vision.VNRequestTextRecognitionLevelFast
            if fast
            else Vision.VNRequestTextRecognitionLevelAccurate
        )
        request.setRecognitionLevel_(level)
        request.setUsesLanguageCorrection_(False)
        ok, err = handler.performRequests_error_([request], None)
        if not ok:  # pragma: no cover - Vision failures are environmental
            raise RuntimeError(f"Vision OCR request failed: {err}")
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if not candidates or not len(candidates):
                continue
            candidate = candidates[0]
            box = observation.boundingBox()
            # Vision uses bottom-left-origin normalized coordinates.
            x = float(box.origin.x)
            y_bottom = float(box.origin.y)
            w = float(box.size.width)
            h = float(box.size.height)
            collected.append(
                OcrToken(
                    text=str(candidate.string()),
                    confidence=float(candidate.confidence()),
                    x=x,
                    y=1.0 - y_bottom - h,
                    width=w,
                    height=h,
                )
            )
    collected.sort(key=lambda t: (round(t.center_y, 2), t.x))
    return collected
