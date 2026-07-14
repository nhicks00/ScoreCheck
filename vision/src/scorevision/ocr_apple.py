"""Apple Vision OCR engine for scorebug reading (macOS only).

Wraps VNRecognizeTextRequest so callers pass numpy RGB frames and receive
plain token tuples. Coordinates are returned in top-left-origin normalized
form (x, y, w, h) relative to the input image.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:
    import Quartz
    import Vision
except ModuleNotFoundError as error:  # pragma: no cover - non-macOS
    raise ModuleNotFoundError(
        "scorevision.ocr_apple requires macOS with pyobjc-framework-Vision"
    ) from error


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
    provider = Quartz.CGDataProviderCreateWithData(None, data, len(data), None)
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
    cg = _cgimage_from_rgb(frame)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    collected: list[OcrToken] = []

    def _handle(request, error) -> None:
        if error is not None:
            return
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

    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(_handle)
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
    collected.sort(key=lambda t: (round(t.center_y, 2), t.x))
    return collected
