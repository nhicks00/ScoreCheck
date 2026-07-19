import { AdminTopbar } from "@/components/AdminTopbar";
import { isAdminRequest } from "@/lib/auth";
import { chatMonitorEnabled, isChatRequest } from "@/lib/chatAuth";
import { chatMessageRowToDto, courtColor, type ChatMessageDbRow } from "@/lib/chatFeed";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { selectYoutubeAuthConfig } from "@/lib/youtubeChat";
import { ChatMonitorClient, type ChatCourtInfo } from "./ChatMonitorClient";

export const dynamic = "force-dynamic";

const errorMessages: Record<string, string> = {
  invalid: "That passcode is not right. Check with the producer and try again.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  disabled: "The chat monitor is not enabled right now. Ask the producer to turn it on."
};

const INITIAL_MESSAGE_LIMIT = 200;

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const env = getEnv();
  const adminAuthorized = await isAdminRequest();

  if (!(await isChatRequest())) {
    const { error } = await searchParams;
    const errorMessage = error ? errorMessages[error] ?? null : null;
    const disabled = !chatMonitorEnabled() || !env.adminSecret;
    return (
      <main className="shell">
        <div className={`container stack ${adminAuthorized ? "" : "auth-container"}`}>
          {adminAuthorized ? <AdminTopbar /> : <span className="brand-mark">Score<em>Check</em></span>}
          <section className={`panel stack ${adminAuthorized ? "chat-admin-login" : ""}`}>
            <h1>Live Chat Monitor</h1>
            <p className="muted">Enter the passcode from your producer to watch YouTube live-chat from every court in one place.</p>
            {disabled && (
              <p className="form-alert" role="alert">
                The chat monitor is not enabled right now. Ask the producer to set <code>CHAT_MONITOR_PASSCODE</code>.
              </p>
            )}
            {errorMessage && <p className="form-alert" role="alert">{errorMessage}</p>}
            <form className="stack" action="/api/chat/login" method="post">
              <label>
                Passcode
                <input name="passcode" type="password" autoFocus required autoComplete="off" inputMode="text" />
              </label>
              <button className="primary" type="submit">Open monitor</button>
            </form>
          </section>
        </div>
      </main>
    );
  }

  const youtubeConfigured = selectYoutubeAuthConfig({
    apiKey: env.youtubeApiKey,
    clientId: env.youtubeClientId,
    clientSecret: env.youtubeClientSecret,
    refreshToken: env.youtubeRefreshToken
  }) !== null;

  const supabaseReady = Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
  const db = supabaseReady ? supabaseAdmin() : null;
  const active = db ? await getActiveEvent(db) : null;

  let courts: ChatCourtInfo[] = [];
  let initialMessages = [] as ReturnType<typeof chatMessageRowToDto>[];

  if (db && active) {
    const [{ data: courtRows }, { data: messageRows }] = await Promise.all([
      db
        .from("courts")
        .select("court_number,display_name,youtube_video_id,youtube_live_chat_id")
        .eq("event_id", active.id)
        .order("court_number", { ascending: true }),
      db
        .from("chat_messages")
        .select("id,youtube_message_id,court_number,court_label,author_name,is_moderator,is_owner,message_text,published_at,created_at")
        .eq("event_id", active.id)
        .order("created_at", { ascending: false })
        .limit(INITIAL_MESSAGE_LIMIT)
    ]);

    courts = ((courtRows as CourtRow[] | null) ?? []).map((row) => ({
      courtNumber: row.court_number,
      label: row.display_name || (row.court_number != null ? `Court ${row.court_number}` : "Court"),
      color: courtColor(row.court_number),
      hasVideoId: Boolean((row.youtube_video_id ?? "").trim()),
      hasLiveChat: Boolean((row.youtube_live_chat_id ?? "").trim())
    }));

    initialMessages = [...((messageRows as ChatMessageDbRow[] | null) ?? [])].reverse().map(chatMessageRowToDto);
  }

  const initialCursorMs = initialMessages.length
    ? Math.max(...initialMessages.map((m) => Date.parse(m.createdAt)).filter(Number.isFinite))
    : null;

  return (
    <ChatMonitorClient
      eventId={active?.id ?? null}
      eventName={active?.name ?? "No active event"}
      courts={courts}
      initialMessages={initialMessages}
      initialCursorMs={initialCursorMs}
      youtubeConfigured={youtubeConfigured}
      chatEnabled={env.youtubeChatEnabled}
      showAdminNav={adminAuthorized}
    />
  );
}

type CourtRow = {
  court_number: number | null;
  display_name: string | null;
  youtube_video_id: string | null;
  youtube_live_chat_id: string | null;
};
