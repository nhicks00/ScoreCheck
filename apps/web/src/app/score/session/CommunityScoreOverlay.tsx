"use client";

import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpToLine,
  Minimize2,
  Minus,
  Plus,
  RefreshCw
} from "lucide-react";
import type { RefObject } from "react";
import type { CommunityWitnessScorerProps } from "./CommunityWitnessScorer";
import { contributionRallyNumber } from "./communityWitnessUi";
import type { CommunityScoreControlsPosition } from "./communityScoreOverlayPreference";
import styles from "./CommunityScoreOverlay.module.css";

export type CommunityScoreOverlayRecovery = {
  message: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
};

type CommunityScoreOverlayProps = CommunityWitnessScorerProps & {
  controlsPosition: CommunityScoreControlsPosition;
  positionAnnouncement: string;
  nativeFullscreen: boolean;
  exitButtonRef: RefObject<HTMLButtonElement | null>;
  recovery: CommunityScoreOverlayRecovery | null;
  onExit: () => void;
  onMoveControls: () => void;
};

export function CommunityScoreOverlay({
  view,
  sideOrder,
  receipt,
  sideAnnouncement,
  addDisabled,
  busyTeam,
  correctionBusyTeam,
  removeDisabled,
  onAddPoint,
  onRemovePoint,
  onSwitchSides,
  availableSets,
  setSelectionBusy,
  onSelectSet,
  controlsPosition,
  positionAnnouncement,
  nativeFullscreen,
  exitButtonRef,
  recovery,
  onExit,
  onMoveControls
}: CommunityScoreOverlayProps) {
  const visibleReceipt = receipt ?? view.latestReceipt ?? {
    rallyNumber: contributionRallyNumber(view.currentRallyNumber, "ADD_POINT"),
    status: "recorded" as const,
    message: `Ready for Rally ${contributionRallyNumber(view.currentRallyNumber, "ADD_POINT")}`
  };
  const nextPosition = controlsPosition === "top" ? "bottom" : "top";

  return (
    <section
      className={`${styles.scoreOverlay} ${controlsPosition === "top" ? styles.controlsTop : styles.controlsBottom}`}
      aria-label="Full screen score controls"
      data-controls-position={controlsPosition}
    >
      <header className={styles.matchSummary}>
        <span>Current set</span>
        {onSelectSet && availableSets && availableSets.length > 0 ? (
          <select
            className={styles.setSelector}
            aria-label="Official current set"
            value={view.currentSet}
            disabled={setSelectionBusy}
            onChange={(event) => onSelectSet(Number(event.target.value))}
          >
            {availableSets.map((setNumber) => (
              <option value={setNumber} key={setNumber}>Set {setNumber}</option>
            ))}
          </select>
        ) : <strong>Set {view.currentSet}</strong>}
        <small>{view.courtLabel} <span aria-hidden="true">·</span> {view.matchLabel}</small>
      </header>

      <div className={styles.teamDocks}>
        {sideOrder.map((side) => {
          const team = view.teams[side];
          const savingPoint = busyTeam === side;
          const savingCorrection = correctionBusyTeam === side;
          return (
            <article
              className={`${styles.teamDock} ${team.tone === "blue" ? styles.blue : styles.red}`}
              key={side}
            >
              <div className={styles.teamIdentity}>
                <h2>{team.name}</h2>
                <output aria-live="polite" aria-label={`${team.name} official score`}>{team.score}</output>
              </div>
              <div className={styles.teamActions} aria-label={`Score actions for ${team.name}`}>
                {!view.isFinal && (
                  <button
                    className={styles.addPoint}
                    type="button"
                    aria-label={`Add one point for ${team.name}`}
                    onClick={() => onAddPoint(side)}
                    disabled={addDisabled}
                  >
                    <Plus size={22} strokeWidth={2.5} aria-hidden="true" />
                    <span>{savingPoint ? "Adding…" : "Add point"}</span>
                  </button>
                )}
                <button
                  className={styles.removePoint}
                  type="button"
                  aria-label={`Remove one point from ${team.name}`}
                  onClick={() => onRemovePoint(side)}
                  disabled={removeDisabled[side]}
                >
                  <Minus size={19} strokeWidth={2.5} aria-hidden="true" />
                  <span>{savingCorrection ? "Removing…" : "Remove point"}</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className={styles.utilityCluster}>
        <div className={styles.utilityBar}>
          <button
            ref={exitButtonRef}
            type="button"
            onClick={onExit}
            aria-label={`Exit ${nativeFullscreen ? "full screen" : "focus view"}`}
          >
            <Minimize2 size={19} aria-hidden="true" />
            <span className={styles.utilityLabel}>Exit</span>
          </button>
          <button type="button" onClick={onSwitchSides} aria-label="Switch team sides visually">
            <ArrowLeftRight size={19} aria-hidden="true" />
            <span className={styles.utilityLabel}>Switch sides</span>
          </button>
          <button
            className={styles.moveControlsButton}
            type="button"
            onClick={onMoveControls}
            aria-label={`Move both team score controls to the ${nextPosition}`}
            aria-pressed={controlsPosition === "top"}
          >
            {controlsPosition === "top"
              ? <ArrowDownToLine size={19} aria-hidden="true" />
              : <ArrowUpToLine size={19} aria-hidden="true" />}
            <span className={styles.utilityLabel}>Controls: {controlsPosition === "top" ? "Top" : "Bottom"}</span>
          </button>
        </div>

        {recovery ? (
          <div className={styles.recovery} role="alert">
            <span>{recovery.message}</span>
            <button type="button" onClick={recovery.onAction} disabled={recovery.actionDisabled}>
              <RefreshCw size={17} aria-hidden="true" /> {recovery.actionLabel}
            </button>
          </div>
        ) : (
          <div className={styles.receipt} role="status" aria-live="polite">
            {visibleReceipt.message}
          </div>
        )}
      </div>

      <p className={styles.visuallyHidden} aria-live="polite">
        {sideAnnouncement} {positionAnnouncement}
      </p>
    </section>
  );
}
