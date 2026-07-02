import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScoreCheck",
  description: "Fan-powered live scoring for beach volleyball broadcasts",
  icons: {
    icon: "/favicon.svg"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
