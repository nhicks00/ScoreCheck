"use client";

import { Copy, ExternalLink, Headphones } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type StreamRow = {
  streamNumber: number;
  roomName: string;
  directorUrl: string;
  sceneUrl: string;
  guestUrl: string;
  guestRelayUrl: string;
};

export function AdminCommentaryClient({
  streams,
  bufferMs,
  portalEnabled
}: {
  streams: StreamRow[];
  bufferMs: number;
  portalEnabled: boolean;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
  }, []);

  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1600);
  }

  function copyCell(key: string, label: string, value: string) {
    return (
      <div className="commentary-url-cell">
        <button type="button" onClick={() => copy(key, value)} title={value}>
          <Copy size={14} /> {copiedKey === key ? "Copied" : label}
        </button>
      </div>
    );
  }

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href="/commentary">Commentator portal</Link>
          </nav>
        </div>

        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Producer tools</p>
            <h1>Commentary Rooms</h1>
            <p className="muted">
              One VDO.Ninja room per stream. Directors monitor talent, scene links feed StreamRun, guest links go to commentators.
            </p>
          </div>
          <span className="status"><Headphones size={14} aria-hidden="true" /> {streams.length} rooms</span>
        </header>

        {!portalEnabled && (
          <div className="panel warn-surface">
            <p>
              The commentator portal at <code>/commentary</code> is disabled — set <code>COMMENTATOR_PASSCODE</code> to open it.
              The room links below work either way.
            </p>
          </div>
        )}

        <section className="panel stack">
          <h2>Room links per stream</h2>
          <div className="scroll-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Stream</th>
                  <th>Room</th>
                  <th>Director</th>
                  <th>Scene (StreamRun)</th>
                  <th>Guest</th>
                  <th>Guest (bad wifi)</th>
                </tr>
              </thead>
              <tbody>
                {streams.map((stream) => (
                  <tr key={stream.streamNumber}>
                    <td>Stream {stream.streamNumber}</td>
                    <td><code>{stream.roomName}</code></td>
                    <td>
                      <div className="commentary-url-cell">
                        <a className="button" href={stream.directorUrl} target="_blank" rel="noreferrer" title={stream.directorUrl}>
                          <ExternalLink size={14} /> Open
                        </a>
                        <button type="button" onClick={() => copy(`director-${stream.streamNumber}`, stream.directorUrl)} title={stream.directorUrl}>
                          <Copy size={14} /> {copiedKey === `director-${stream.streamNumber}` ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </td>
                    <td>{copyCell(`scene-${stream.streamNumber}`, "Copy scene URL", stream.sceneUrl)}</td>
                    <td>{copyCell(`guest-${stream.streamNumber}`, "Copy guest URL", stream.guestUrl)}</td>
                    <td>{copyCell(`relay-${stream.streamNumber}`, "Copy relay URL", stream.guestRelayUrl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted commentary-buffer-note">
            Scene URLs carry <code>buffer={bufferMs}</code>: {bufferMs}ms delays commentary audio to align with the delayed
            program video — tune via <code>VDO_SCENE_BUFFER_MS</code>; clap-test per court.
          </p>
        </section>

        <section className="grid two">
          <div className="panel stack">
            <h2>Wire-up order</h2>
            <ol className="commentary-admin-steps">
              <li>Open the Director link for the court and stay in it — you are the room owner.</li>
              <li>Paste the Scene URL into a StreamRun HTML/browser element on that stream&apos;s YouTube branch only.</li>
              <li>Send commentators to <code>/commentary</code> with the passcode; they join the room from their court page.</li>
              <li>Clap-test: talent claps on a visible rally end, adjust <code>VDO_SCENE_BUFFER_MS</code> until audio matches video.</li>
            </ol>
          </div>
          <div className="panel stack">
            <h2>Guest link flags</h2>
            <p className="muted">
              Guest links are mic-only with a noise gate and 80 kbps opus. The bad-wifi variant adds <code>&amp;relay</code> to
              force TURN routing — steadier on hotel wifi and hotspots, at slightly higher latency.
            </p>
            <p className="muted">
              Keep the MediaMTX preview branch commentary-free so commentators and scorers keep an undelayed, clean feed.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
