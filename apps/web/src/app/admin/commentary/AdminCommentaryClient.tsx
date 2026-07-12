"use client";

import { Copy, ExternalLink, Headphones } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type StreamRow = {
  streamNumber: number;
  roomName: string;
  commentatorUrl: string;
};

export function AdminCommentaryClient({
  streams,
  portalEnabled,
  liveKitConfigured
}: {
  streams: StreamRow[];
  portalEnabled: boolean;
  liveKitConfigured: boolean;
}) {
  const [copiedCourt, setCopiedCourt] = useState<number | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
  }, []);

  function copy(stream: StreamRow) {
    void navigator.clipboard.writeText(stream.commentatorUrl);
    setCopiedCourt(stream.streamNumber);
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedCourt(null), 1600);
  }

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/monitor">Monitor</Link>
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href="/commentary">Commentator portal</Link>
          </nav>
        </div>

        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Producer tools</p>
            <h1>Commentary Rooms</h1>
            <p className="muted">One authenticated self-hosted LiveKit audio room per court.</p>
          </div>
          <span className={`status ${liveKitConfigured ? "success" : "error"}`}>
            <Headphones size={14} aria-hidden="true" /> {liveKitConfigured ? "Audio server ready" : "Audio server offline"}
          </span>
        </header>

        {(!portalEnabled || !liveKitConfigured) && (
          <div className="panel warn-surface">
            <p>
              {!portalEnabled ? <><code>COMMENTATOR_PASSCODE</code> must be set. </> : null}
              {!liveKitConfigured ? <>The LiveKit commentary URL and API credentials must be configured.</> : null}
            </p>
          </div>
        )}

        <section className="panel stack">
          <h2>Room links per stream</h2>
          <div className="scroll-table">
            <table className="table">
              <thead><tr><th>Stream</th><th>Room</th><th>Commentator link</th><th>Program subscription</th></tr></thead>
              <tbody>
                {streams.map((stream) => (
                  <tr key={stream.streamNumber}>
                    <td>Stream {stream.streamNumber}</td>
                    <td><code>{stream.roomName}</code></td>
                    <td>
                      <div className="commentary-url-cell">
                        <a className="button" href={stream.commentatorUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} /> Open
                        </a>
                        <button type="button" onClick={() => copy(stream)}>
                          <Copy size={14} /> {copiedCourt === stream.streamNumber ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </td>
                    <td>Automatic when the court program scene starts</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid two">
          <div className="panel stack">
            <h2>Commentator check</h2>
            <ol className="commentary-admin-steps">
              <li>Open the court link and sign in with the commentator passcode.</li>
              <li>Join audio, approve microphone access, and verify that the level meter moves.</li>
              <li>Keep headphones on and the low-latency court preview muted.</li>
              <li>Confirm the production console reports an audio track and recent non-silence.</li>
            </ol>
          </div>
          <div className="panel stack">
            <h2>Network recovery</h2>
            <p className="muted">LiveKit automatically attempts direct UDP, TURN/UDP, ICE/TCP, and TURN/TLS. There is no separate bad-wifi URL.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
