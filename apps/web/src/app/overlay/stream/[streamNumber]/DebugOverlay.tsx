"use client";

export function DebugOverlay({ streamNumber }: { streamNumber: string }) {
  return (
    <main className="debug-overlay-stage">
      <div className="debug-outline" />
      <section className="debug-card">
        <p className="debug-kicker">ScoreCheck HTML overlay test</p>
        <h1>Stream {streamNumber}</h1>
        <p>Visible in StreamRun = browser source works</p>
      </section>
      <div className="debug-corner top-left">TOP LEFT</div>
      <div className="debug-corner top-right">TOP RIGHT</div>
      <div className="debug-corner bottom-left">BOTTOM LEFT</div>
      <div className="debug-corner bottom-right">BOTTOM RIGHT</div>

      <style jsx global>{`
        html,
        body {
          background: #101820 !important;
          margin: 0;
          overflow: hidden;
        }
      `}</style>
      <style jsx>{`
        .debug-overlay-stage {
          align-items: center;
          background:
            linear-gradient(135deg, rgba(0, 255, 102, 0.22) 0 25%, rgba(255, 0, 184, 0.22) 25% 50%, rgba(255, 209, 0, 0.22) 50% 75%, rgba(0, 148, 255, 0.22) 75% 100%),
            #101820;
          color: #ffffff;
          display: flex;
          font-family: Arial, Helvetica, sans-serif;
          height: 100vh;
          justify-content: center;
          overflow: hidden;
          position: relative;
          width: 100vw;
        }
        .debug-outline {
          border: 18px solid #00ff66;
          bottom: 0;
          box-shadow: inset 0 0 0 10px #ff00b8, inset 0 0 0 22px #ffd100;
          left: 0;
          pointer-events: none;
          position: absolute;
          right: 0;
          top: 0;
        }
        .debug-card {
          background: #ff00b8;
          border: 8px solid #ffffff;
          box-shadow: 0 24px 90px rgba(0, 0, 0, 0.7);
          padding: 44px 56px;
          text-align: center;
          text-transform: uppercase;
        }
        .debug-kicker {
          font-size: 28px;
          font-weight: 900;
          margin: 0 0 12px;
        }
        h1 {
          font-size: 96px;
          line-height: 1;
          margin: 0;
        }
        .debug-card p:last-child {
          font-size: 30px;
          font-weight: 900;
          margin: 18px 0 0;
        }
        .debug-corner {
          background: #00ff66;
          color: #101820;
          font-size: 26px;
          font-weight: 900;
          padding: 12px 18px;
          position: absolute;
        }
        .top-left {
          left: 28px;
          top: 28px;
        }
        .top-right {
          right: 28px;
          top: 28px;
        }
        .bottom-left {
          bottom: 28px;
          left: 28px;
        }
        .bottom-right {
          bottom: 28px;
          right: 28px;
        }
      `}</style>
    </main>
  );
}
