import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MultiCourtScore Cloud",
  description: "Cloud-hosted live scoreboard overlays for beach volleyball streams"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
