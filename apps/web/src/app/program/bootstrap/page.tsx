import type { Metadata } from "next";
import { Suspense } from "react";
import { ProgramBootstrapClient } from "./ProgramBootstrapClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Program | ScoreCheck",
  robots: { index: false, follow: false }
};

export default function ProgramBootstrapPage() {
  return (
    <Suspense fallback={<main>Preparing program scene...</main>}>
      <ProgramBootstrapClient />
    </Suspense>
  );
}
