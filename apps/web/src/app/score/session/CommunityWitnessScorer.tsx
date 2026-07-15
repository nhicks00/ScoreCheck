"use client";

import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  AudioLines,
  Check,
  Circle,
  HeartHandshake,
  Minus,
  PencilLine,
  Plus,
  Radio,
  UsersRound
} from "lucide-react";
import { contributionRallyNumber, journeyWithReceipt, type CommunityReceipt, type CommunityWitnessViewModel, type TeamSide } from "./communityWitnessUi";
import styles from "./CommunityWitnessScorer.module.css";

export type CommunityWitnessScorerProps = {
  view: CommunityWitnessViewModel;
  sideOrder: readonly [TeamSide, TeamSide];
  receipt: CommunityReceipt | null;
  sideAnnouncement: string;
  density?: "standard" | "watch";
  addDisabled: boolean;
  busyTeam: TeamSide | null;
  correctionBusyTeam: TeamSide | null;
  removeDisabled: Record<TeamSide, boolean>;
  onAddPoint: (side: TeamSide) => void;
  onRemovePoint: (side: TeamSide) => void;
  onSwitchSides: () => void;
  availableSets?: readonly number[];
  setSelectionBusy?: boolean;
  onSelectSet?: (setNumber: number) => void;
};

export function CommunityWitnessScorer({
  view,
  sideOrder,
  receipt,
  sideAnnouncement,
  density = "standard",
  addDisabled,
  busyTeam,
  correctionBusyTeam,
  removeDisabled,
  onAddPoint,
  onRemovePoint,
  onSwitchSides,
  availableSets = [],
  setSelectionBusy = false,
  onSelectSet
}: CommunityWitnessScorerProps) {
  const visibleReceipt = receipt ?? view.latestReceipt ?? {
    rallyNumber: null,
    status: "recorded" as const,
    message: `Ready for Rally ${contributionRallyNumber(view.currentRallyNumber, "ADD_POINT")} · your contribution will appear here`
  };
  const visibleJourney = journeyWithReceipt(view.rallyJourney, receipt ?? view.latestReceipt);

  return (
    <section className={`${styles.scoreboard} ${density === "watch" ? styles.watchDensity : ""}`} aria-label="Community witness scorekeeper">
      <header className={styles.matchHeader}>
        <h1>{view.courtLabel} <span aria-hidden="true">·</span> {view.matchLabel}</h1>
        <span className={`${styles.liveStatus} ${view.isLive ? styles.live : styles.complete}`}>
          <Circle size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {view.isLive ? "Live" : "Complete"}
        </span>
      </header>

      <div className={styles.setStage} aria-label={`Set ${view.currentSet}`}>
        <span aria-hidden="true" />
        {onSelectSet && availableSets.length > 0 ? (
          <label className={styles.setSelector}>
            <span>Current set</span>
            <select
              aria-label="Official current set"
              value={view.currentSet}
              disabled={setSelectionBusy}
              onChange={(event) => onSelectSet(Number(event.target.value))}
            >
              {availableSets.map((setNumber) => (
                <option value={setNumber} key={setNumber}>Set {setNumber}</option>
              ))}
            </select>
          </label>
        ) : <strong>Set {view.currentSet}</strong>}
        <span aria-hidden="true" />
      </div>

      <div className={styles.scoreContext}>
        <div className={styles.contextLabel}>
          <Radio size={24} aria-hidden="true" />
          <span>Official score</span>
        </div>
        <button className={styles.switchButton} type="button" onClick={onSwitchSides}>
          <ArrowLeftRight size={21} aria-hidden="true" />
          Switch sides
        </button>
      </div>

      <p className={styles.visuallyHidden} aria-live="polite">{sideAnnouncement}</p>

      <div className={styles.teamGrid}>
        <span className={styles.versus} aria-hidden="true">vs</span>
        {sideOrder.map((side) => {
          const team = view.teams[side];
          const savingPoint = busyTeam === side;
          const savingCorrection = correctionBusyTeam === side;
          return (
            <article className={`${styles.teamPanel} ${team.tone === "blue" ? styles.blue : styles.red}`} key={side}>
              <div className={styles.teamIdentity}>
                <h2>{team.name}</h2>
                <span className={styles.visuallyHidden}>{team.setsWon} {team.setsWon === 1 ? "set" : "sets"} won</span>
              </div>
              <output className={styles.teamScore} aria-live="polite" aria-label={`${team.name} official score`}>
                {team.score}
              </output>
              <span className={styles.teamRule} aria-hidden="true" />

              <div className={`${styles.contributionControls} ${view.isFinal ? styles.finalCorrectionControls : ""}`} aria-label={`Your contribution for ${team.name}`}>
                {!view.isFinal && (
                  <button
                    className={styles.addPoint}
                    type="button"
                    aria-label={`Add one point for ${team.name}`}
                    onClick={() => onAddPoint(side)}
                    disabled={addDisabled}
                  >
                    <span className={styles.controlIcon}><Plus size={28} strokeWidth={2.4} aria-hidden="true" /></span>
                    <span>{savingPoint ? "Recording…" : "Add point"}</span>
                  </button>
                )}
                <button
                  className={styles.removePoint}
                  type="button"
                  aria-label={`Remove one point from ${team.name}`}
                  onClick={() => onRemovePoint(side)}
                  disabled={removeDisabled[side]}
                >
                  <span className={styles.controlIcon}><Minus size={25} strokeWidth={2.4} aria-hidden="true" /></span>
                  <span>{savingCorrection ? "Correcting…" : "Remove point"}</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {view.isFinal && (
        <section className={styles.finalRecap} aria-labelledby="community-recap-title">
          <span className={styles.recapIcon}><HeartHandshake size={24} aria-hidden="true" /></span>
          <div>
            <h2 id="community-recap-title">Your match contribution</h2>
            <p>{personalRecap(view.personalSummary)}</p>
          </div>
        </section>
      )}

      <section className={styles.journey} aria-labelledby="rally-journey-title">
        <div className={styles.sectionLabel}>
          <span className={styles.sectionIcon}><Activity size={19} aria-hidden="true" /></span>
          <h2 id="rally-journey-title">Rally journey</h2>
        </div>
        <ol className={styles.rallyTrack}>
          {visibleJourney.map((rally) => (
            <li className={`${styles.rallyStep} ${styles[rally.status]}`} key={rally.rallyNumber}>
              <span className={styles.rallyMarker}>
                {rally.status === "broadcast" || rally.status === "confirmed"
                  ? <Check size={20} strokeWidth={2.8} aria-hidden="true" />
                  : rally.status === "corrected"
                    ? <PencilLine size={17} strokeWidth={2.4} aria-hidden="true" />
                  : rally.status === "review"
                    ? <AlertTriangle size={17} aria-hidden="true" />
                    : rally.status === "voided"
                      ? <Minus size={18} aria-hidden="true" />
                    : <Circle size={15} fill="currentColor" strokeWidth={0} aria-hidden="true" />}
              </span>
              <span className={styles.rallyNumber}>{rally.rallyNumber}</span>
              {rally.status === "voided" && <span className={styles.rallyStateLabel}>Voided</span>}
              {rally.status === "corrected" && <span className={styles.rallyStateLabel}>Corrected</span>}
              <span className={styles.visuallyHidden}>{rallyStatusLabel(rally.status)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${styles.receipt} ${styles[visibleReceipt.status]}`} role="status" aria-live="polite">
        <span className={styles.receiptIcon}><AudioLines size={21} aria-hidden="true" /></span>
        <p>{visibleReceipt.message}</p>
      </section>

      <section className={styles.coverage} aria-label="Community coverage">
        <UsersRound size={24} aria-hidden="true" />
        <p>{view.coverageLabel}</p>
      </section>
    </section>
  );
}

function personalRecap(summary: CommunityWitnessViewModel["personalSummary"]): string {
  const parts = [
    `You recorded ${summary.contributionsRecorded} ${summary.contributionsRecorded === 1 ? "rally call" : "rally calls"}`,
    `helped confirm ${summary.confirmedCalls}`
  ];
  if (summary.reviewTriggers > 0) parts.push(`flagged ${summary.reviewTriggers} ${summary.reviewTriggers === 1 ? "review" : "reviews"}`);
  if (summary.correctionsHelped > 0) parts.push(`helped correct ${summary.correctionsHelped}`);
  return parts.join(" · ");
}

function rallyStatusLabel(status: CommunityWitnessViewModel["rallyJourney"][number]["status"]): string {
  switch (status) {
    case "broadcast": return "included in the official score";
    case "confirmed": return "confirmed together";
    case "corrected": return "score corrected";
    case "review": return "under review";
    case "pending": return "awaiting resolution";
    case "voided": return "voided";
  }
}
