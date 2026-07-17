import { notFound } from "next/navigation";
import { checkProgramToken } from "@/lib/program";
import { courtPreviewStreamPath, courtStreamSources } from "@/lib/video";
import { RehearsalCommentaryClient } from "./RehearsalCommentaryClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function RehearsalCommentaryPage({ params, searchParams }: {
  params: Promise<{ courtNumber: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  if (process.env.NEXT_PUBLIC_SCORECHECK_REHEARSAL !== "true") notFound();
  const { token } = await searchParams;
  if (typeof token !== "string" || !checkProgramToken(token)) notFound();

  const { courtNumber: courtParam } = await params;
  const courtNumber = Number(courtParam);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 8) notFound();
  const whepUrl = courtStreamSources(courtPreviewStreamPath(courtNumber)).whepUrl;
  if (!whepUrl) notFound();

  return <RehearsalCommentaryClient courtNumber={courtNumber} whepUrl={whepUrl} />;
}
