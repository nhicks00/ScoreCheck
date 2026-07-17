"use client";

import { useCallback, useRef, useState } from "react";
import { CommentaryAudioClient } from "@/app/commentary/court/[courtNumber]/CommentaryAudioClient";
import { StreamPlayer } from "@/components/StreamPlayer";
import type { StreamTimingSample } from "@/lib/rtcTiming";

type RehearsalCommentaryClientProps = {
  courtNumber: number;
  whepUrl: string;
};

export function RehearsalCommentaryClient({ courtNumber, whepUrl }: RehearsalCommentaryClientProps) {
  const previewTimingRef = useRef<StreamTimingSample | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const updatePreviewTiming = useCallback((sample: StreamTimingSample | null) => {
    previewTimingRef.current = sample;
    setPreviewReady(sample !== null);
  }, []);

  return (
    <main className="shell" data-rehearsal-commentary-court={courtNumber}>
      <div className="container stack">
        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Isolated event rehearsal</p>
            <h1>Camera {courtNumber} commentary</h1>
          </div>
          <span className={`status ${previewReady ? "success" : ""}`} data-preview-state>
            {previewReady ? "Preview live" : "Connecting preview"}
          </span>
        </header>
        <div className="commentary-court-layout">
          <section className="commentary-main" aria-label="Rehearsal court preview">
            <StreamPlayer
              courtNumber={courtNumber}
              sources={{ whepUrl, hlsUrl: null }}
              mode="preview"
              onTimingSample={updatePreviewTiming}
            />
          </section>
          <aside className="commentary-rail" aria-label="Rehearsal audio room">
            <CommentaryAudioClient
              courtNumber={courtNumber}
              displayName={`Rehearsal commentator ${courtNumber}`}
              configured
              previewTimingRef={previewTimingRef}
              audioProcessing={false}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
