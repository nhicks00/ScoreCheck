export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        html, body {
          background: transparent !important;
          margin: 0;
          overflow: hidden;
        }
      `}</style>
      {children}
    </>
  );
}
