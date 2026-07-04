"use client";

import { useEffect, useMemo, useState } from "react";
import {
  coerceOverlayState,
  displayOverlayName,
  fallbackOverlayState,
  overlayPhaseText,
  scorebugDisplayScores
} from "@/lib/overlayState";
import { createBrowserSupabase } from "@/lib/supabase-browser";

export function OverlayClient({ courtNumber, eventId }: { courtNumber: string; eventId: string; theme: string }) {
  const courtNumberValue = Number(courtNumber) || 1;
  const [state, setState] = useState(() => fallbackOverlayState(courtNumberValue));
  const [connected, setConnected] = useState(true);
  const stateUrl = useMemo(() => `/api/overlay/court/${courtNumber}/state${eventId ? `?eventId=${eventId}` : ""}`, [courtNumber, eventId]);
  const realtimeEventId = eventId || state.eventId;
  const realtimeTopic = useMemo(() => realtimeEventId ? `overlay:${realtimeEventId}:court:${courtNumber}` : null, [courtNumber, realtimeEventId]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(stateUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = await res.json();
        if (!cancelled) {
          setState(coerceOverlayState(next, courtNumberValue));
          setConnected(true);
        }
      } catch {
        if (!cancelled) setConnected(false);
      }
    }
    void tick();
    const id = window.setInterval(tick, connected ? 2000 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [stateUrl, connected, courtNumberValue]);

  useEffect(() => {
    if (!realtimeTopic) return;
    const supabase = createBrowserSupabase();
    if (!supabase) return;
    const channel = supabase
      .channel(realtimeTopic)
      .on("broadcast", { event: "overlay_state" }, ({ payload }) => {
        setState(coerceOverlayState(payload, courtNumberValue));
        setConnected(true);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setConnected(true);
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [realtimeTopic, courtNumberValue]);

  const layout = state.layout === "top-left" ? "top-left" : "bottom-left";
  const isIntermission = state.phase === "IDLE" || state.phase === "PREMATCH";
  const displayScores = scorebugDisplayScores(state);
  const status = overlayPhaseText(state, connected);

  return (
    <main className={`overlay-stage layout-${layout}`}>
      <div className={`overlay-position ${layout}`}>
        <div className={`trad-board carbon-bar ${isIntermission ? "trad-intermission" : ""}`}>
          <TradRow
            row="one"
            name={displayOverlayName(state.match.teamA.name)}
            seed={state.match.teamA.seed}
            serving={state.score.servingTeam === "A"}
            score={displayScores.teamAScore}
            setScores={displayScores.teamASetScores}
            hideScoreDetails={isIntermission}
          />
          <div className="trad-divider" />
          <TradRow
            row="two"
            name={displayOverlayName(state.match.teamB.name)}
            seed={state.match.teamB.seed}
            serving={state.score.servingTeam === "B"}
            score={displayScores.teamBScore}
            setScores={displayScores.teamBSetScores}
            hideScoreDetails={isIntermission}
          />
          <div className="accent-line" />
        </div>

        <div className={`bubble-bar ${layout} ${(!connected || state.health.stale || state.frozen) ? "warn" : ""}`}>
          {state.courtLabel && <span>{state.courtLabel}</span>}
          <span>{status}</span>
          {state.match.matchNumber && <span>Match {state.match.matchNumber}</span>}
        </div>
      </div>

      <style jsx global>{`
        html, body {
          background: transparent !important;
          margin: 0;
          overflow: hidden;
        }
      `}</style>
      <style jsx>{`
        .overlay-stage {
          --overlay-font: "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
          --overlay-condensed-font: "SF Pro Display", "Helvetica Neue", "Arial Narrow", Arial, sans-serif;
          background: transparent;
          color: white;
          font-family: var(--overlay-font);
          height: 100vh;
          overflow: hidden;
          position: relative;
          width: 100vw;
        }
        .overlay-position {
          left: 1rem;
          max-width: calc(100vw - 2rem);
          pointer-events: none;
          position: fixed;
          z-index: 20;
        }
        .overlay-position.top-left {
          top: 1rem;
        }
        .overlay-position.bottom-left {
          bottom: 1rem;
        }
        .carbon-bar {
          background: linear-gradient(180deg, #1a1a1a 0%, #080808 100%);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .trad-board {
          border-radius: 0.6rem;
          box-shadow: 0 10px 34px rgba(0, 0, 0, 0.85);
          contain: layout paint style;
          display: flex;
          flex-direction: column;
          isolation: isolate;
          min-width: 430px;
          overflow: hidden;
          position: relative;
          transform: translateZ(0);
          width: auto;
        }
        .trad-divider {
          background: rgba(255, 255, 255, 0.1);
          height: 1px;
        }
        .accent-line {
          background: linear-gradient(90deg, transparent, rgba(212, 175, 55, 0.5), transparent);
          bottom: 0;
          height: 2px;
          left: 0;
          position: absolute;
          right: 0;
          z-index: 30;
        }
        .bubble-bar {
          align-items: center;
          background: rgba(0, 0, 0, 0.88);
          border: 1px solid rgba(212, 175, 55, 0.42);
          color: rgba(255, 255, 255, 0.78);
          display: inline-flex;
          font-size: 0.72rem;
          font-weight: 850;
          gap: 0.65rem;
          justify-content: center;
          letter-spacing: 0.06em;
          margin-left: 0.48rem;
          max-width: calc(100% - 0.96rem);
          min-height: 1.65rem;
          padding: 0.24rem 0.7rem 0.3rem;
          text-transform: uppercase;
        }
        .bubble-bar.top-left {
          border-radius: 0 0 0.5rem 0.5rem;
          border-top: none;
        }
        .bubble-bar.bottom-left {
          border-bottom: none;
          border-radius: 0.5rem 0.5rem 0 0;
          bottom: 100%;
          position: absolute;
        }
        .bubble-bar.warn {
          color: #f9e29b;
        }
        .bubble-bar span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .bubble-bar span:first-child {
          max-width: 18rem;
        }
        .bubble-bar span:not(:first-child) {
          flex: 0 0 auto;
        }
        @media (max-width: 560px) {
          .overlay-position {
            left: 0.5rem;
          }
          .overlay-position.top-left {
            top: 0.5rem;
          }
          .overlay-position.bottom-left {
            bottom: 0.5rem;
          }
          .trad-board {
            min-width: min(430px, calc(100vw - 1rem));
          }
        }
      `}</style>
    </main>
  );
}

function TradRow({
  row,
  name,
  seed,
  serving,
  score,
  setScores,
  hideScoreDetails
}: {
  row: "one" | "two";
  name: string;
  seed: string | null;
  serving: boolean;
  score: number;
  setScores: number[];
  hideScoreDetails: boolean;
}) {
  return (
    <div className={`trad-row ${row} ${hideScoreDetails ? "hide-score-details" : ""}`}>
      <span className={`trad-serve ${serving ? "active" : ""}`}><ServeIcon size={18} /></span>
      <span className="trad-seed">{seed ?? ""}</span>
      <span className="trad-name">{name}</span>
      <div className="trad-sets">
        {setScores.map((setScore, index) => <span key={index} className="trad-set-cell">{setScore}</span>)}
      </div>
      <span className="trad-score-shell">
        <span className="trad-score-cell">
          <span key={score} className="trad-current-score">{score}</span>
        </span>
      </span>
      <style jsx>{`
        .trad-row {
          align-items: center;
          box-sizing: border-box;
          display: grid;
          gap: 0;
          grid-template-columns: 24px 1.75rem minmax(11rem, 1fr) auto 3.4rem;
          height: 2.95rem;
          min-width: 0;
          padding: 0 0 0 0.6rem;
          position: relative;
          width: 100%;
        }
        .trad-serve {
          align-items: center;
          display: inline-flex;
          grid-column: 1;
          height: 24px;
          justify-content: center;
          justify-self: center;
          opacity: 0;
          width: 24px;
        }
        .trad-serve.active {
          opacity: 1;
        }
        .trad-seed {
          align-items: center;
          color: rgba(212, 175, 55, 0.8);
          display: inline-flex;
          font-size: 0.74rem;
          font-weight: 700;
          grid-column: 2;
          justify-content: center;
          min-width: 1.75rem;
          text-align: center;
          width: 1.75rem;
        }
        .trad-name {
          align-items: center;
          color: rgba(255, 255, 255, 0.98);
          display: flex;
          font-family: var(--overlay-condensed-font);
          font-size: 1.05rem;
          font-style: normal;
          font-weight: 850;
          grid-column: 3;
          letter-spacing: 0;
          line-height: 1.02;
          max-width: none;
          min-width: 0;
          overflow: hidden;
          padding-right: 0.75rem;
          text-overflow: ellipsis;
          text-transform: uppercase;
          white-space: nowrap;
        }
        .trad-sets {
          align-items: center;
          display: flex;
          grid-column: 4;
          justify-self: end;
        }
        .trad-set-cell {
          border-left: 1px solid rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.48);
          font-family: var(--overlay-condensed-font);
          font-size: 1.48rem;
          font-variant-numeric: tabular-nums;
          font-weight: 800;
          letter-spacing: 0;
          line-height: 1;
          min-width: 2.45rem;
          padding: 0 0.18rem;
          text-align: center;
        }
        .trad-score-shell {
          align-items: stretch;
          align-self: stretch;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.035) 100%);
          border-left: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
          box-sizing: border-box;
          display: inline-flex;
          grid-column: 5;
          justify-content: flex-start;
          justify-self: stretch;
          max-width: 3.4rem;
          min-width: 3.4rem;
          overflow: hidden;
          position: relative;
          width: 3.4rem;
        }
        .trad-score-cell {
          align-items: center;
          align-self: stretch;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.04) 100%);
          box-sizing: border-box;
          display: flex;
          flex: 0 0 3.4rem;
          justify-content: center;
          max-width: 3.4rem;
          min-width: 3.4rem;
          width: 3.4rem;
        }
        .trad-row.one .trad-score-shell,
        .trad-row.one .trad-score-cell {
          border-top-right-radius: 0.6rem;
        }
        .trad-row.two .trad-score-shell,
        .trad-row.two .trad-score-cell {
          border-bottom-right-radius: 0.6rem;
        }
        .trad-current-score {
          background: linear-gradient(180deg, #f9e29b 0%, #d4af37 100%);
          background-clip: text;
          color: transparent;
          display: grid;
          animation: score-pop 420ms cubic-bezier(0.2, 0.72, 0.25, 1);
          font-family: var(--overlay-condensed-font);
          font-feature-settings: "tnum" 1, "lnum" 1;
          font-size: 1.48rem;
          font-style: normal;
          font-variant-numeric: tabular-nums;
          font-weight: 900;
          height: 100%;
          letter-spacing: 0;
          line-height: 1;
          place-items: center;
          text-align: center;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          width: 100%;
        }
        @keyframes score-pop {
          0% {
            filter: brightness(1.55);
            transform: translateY(1px) scale(0.96);
          }
          45% {
            filter: brightness(1.2);
            transform: translateY(0) scale(1.04);
          }
          100% {
            filter: brightness(1);
            transform: translateY(0) scale(1);
          }
        }
        .hide-score-details .trad-current-score,
        .hide-score-details .trad-sets,
        .hide-score-details .trad-score-shell,
        .hide-score-details .trad-serve {
          visibility: hidden;
        }
        .hide-score-details {
          grid-template-columns: 24px 1.75rem minmax(11rem, 1fr);
          padding-right: 0.8rem;
        }
        .hide-score-details .trad-score-shell {
          display: none;
        }
        @media (max-width: 560px) {
          .trad-row {
            grid-template-columns: 20px 1.4rem minmax(8rem, 1fr) auto 3rem;
            height: 2.75rem;
            padding-left: 0.4rem;
          }
          .trad-name {
            font-size: 0.92rem;
            padding-right: 0.45rem;
          }
          .trad-set-cell {
            font-size: 1.2rem;
            min-width: 2rem;
          }
          .trad-score-shell,
          .trad-score-cell {
            max-width: 3rem;
            min-width: 3rem;
            width: 3rem;
          }
          .trad-score-cell {
            flex-basis: 3rem;
          }
          .trad-current-score {
            font-size: 1.3rem;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .trad-current-score {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

function ServeIcon({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="#D4AF37">
      <circle cx="12" cy="12" r="10" fill="none" stroke="#D4AF37" strokeWidth="2" />
      <path d="M6.5 3.5c3.5 2 5 5.5 5 8.5" fill="none" stroke="#D4AF37" strokeWidth="1.5" />
      <path d="M17.5 20.5c-3.5-2-5-5.5-5-8.5" fill="none" stroke="#D4AF37" strokeWidth="1.5" />
      <path d="M2.5 10c3 1.5 7 1.5 10 0s7-1.5 10 0" fill="none" stroke="#D4AF37" strokeWidth="1.5" />
    </svg>
  );
}
