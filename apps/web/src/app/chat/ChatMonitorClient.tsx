"use client";

import { ArrowDown, MessageSquare, Radio, Search, Settings, WifiOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { courtColor, relativeTime, type ChatMessageDto } from "@/lib/chatFeed";
import { createBrowserSupabase } from "@/lib/supabase-browser";

export type ChatCourtInfo = {
  courtNumber: number | null;
  label: string;
  color: string;
  hasVideoId: boolean;
  hasLiveChat: boolean;
};

type Props = {
  eventId: string | null;
  eventName: string;
  courts: ChatCourtInfo[];
  initialMessages: ChatMessageDto[];
  initialCursorMs: number | null;
  youtubeConfigured: boolean;
  chatEnabled: boolean;
};

const POLL_MS = 8_000;
const NOW_TICK_MS = 30_000;
const ACTIVE_WINDOW_MS = 15 * 60_000;
const MAX_MESSAGES = 500;
const SCROLL_BOTTOM_THRESHOLD = 80;

export function ChatMonitorClient({
  eventId,
  eventName,
  courts,
  initialMessages,
  initialCursorMs,
  youtubeConfigured,
  chatEnabled
}: Props) {
  const [messages, setMessages] = useState<ChatMessageDto[]>(initialMessages);
  const [hiddenCourts, setHiddenCourts] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const seenIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.youtubeMessageId)));
  const cursorMs = useRef<number>(initialCursorMs ?? 0);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // Merge freshly-arrived messages, de-duping on the YouTube id and keeping the
  // feed ordered oldest-first. Bounds memory at MAX_MESSAGES.
  const ingest = useCallback((incoming: ChatMessageDto[]) => {
    if (!incoming.length) return;
    const fresh = incoming.filter((m) => m.youtubeMessageId && !seenIds.current.has(m.youtubeMessageId));
    if (!fresh.length) return;
    for (const m of fresh) {
      seenIds.current.add(m.youtubeMessageId);
      const ms = Date.parse(m.createdAt);
      if (Number.isFinite(ms) && ms > cursorMs.current) cursorMs.current = ms;
    }
    setMessages((prev) => {
      const merged = [...prev, ...fresh].sort((a, b) => sortKey(a) - sortKey(b));
      return merged.length > MAX_MESSAGES ? merged.slice(merged.length - MAX_MESSAGES) : merged;
    });
  }, []);

  // Polling backbone — reliable regardless of realtime delivery. Serves as both
  // the incremental fetch and the realtime backfill.
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    async function tick() {
      try {
        const url = `/api/chat/messages?eventId=${encodeURIComponent(eventId!)}&sinceMs=${cursorMs.current || ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: ChatMessageDto[] };
        if (!cancelled && Array.isArray(json.messages)) ingest(json.messages);
      } catch {
        // Network blips are transient; the next tick recovers.
      }
    }
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [eventId, ingest]);

  // Realtime accelerant — instant INSERTs when Supabase realtime delivers.
  useEffect(() => {
    if (!eventId) return;
    const supabase = createBrowserSupabase();
    if (!supabase) return;
    const channel = supabase
      .channel(`chat:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `event_id=eq.${eventId}` },
        (payload: { new?: Record<string, unknown> }) => {
          const dto = coerceRealtimeRow(payload.new);
          if (dto) ingest([dto]);
        }
      )
      .subscribe((status) => setRealtimeConnected(status === "SUBSCRIBED"));
    return () => {
      setRealtimeConnected(false);
      void supabase.removeChannel(channel);
    };
  }, [eventId, ingest]);

  // Tick "now" so relative times and live/active recency stay fresh.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Keep pinned to the newest message unless the operator has scrolled up.
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distance <= SCROLL_BOTTOM_THRESHOLD);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }, []);

  // Per-court stats derived from the loaded feed.
  const { countByCourt, latestByCourt } = useMemo(() => {
    const count = new Map<number, number>();
    const latest = new Map<number, number>();
    for (const m of messages) {
      if (m.courtNumber == null) continue;
      count.set(m.courtNumber, (count.get(m.courtNumber) ?? 0) + 1);
      const ms = Date.parse(m.publishedAt ?? m.createdAt);
      if (Number.isFinite(ms)) latest.set(m.courtNumber, Math.max(latest.get(m.courtNumber) ?? 0, ms));
    }
    return { countByCourt: count, latestByCourt: latest };
  }, [messages]);

  // Chips: every court that is live or has messages, marked active when it has
  // a resolved live chat or recent traffic. Reflects streams coming and going.
  const chips = useMemo(() => {
    const byNumber = new Map<number, { label: string; color: string; hasLiveChat: boolean }>();
    for (const c of courts) {
      if (c.courtNumber == null) continue;
      byNumber.set(c.courtNumber, { label: c.label, color: c.color, hasLiveChat: c.hasLiveChat });
    }
    for (const m of messages) {
      if (m.courtNumber == null || byNumber.has(m.courtNumber)) continue;
      byNumber.set(m.courtNumber, { label: m.courtLabel || `Court ${m.courtNumber}`, color: courtColor(m.courtNumber), hasLiveChat: false });
    }
    return [...byNumber.entries()]
      .map(([courtNumber, info]) => {
        const latest = latestByCourt.get(courtNumber) ?? 0;
        const recentlyActive = latest > 0 && nowMs - latest <= ACTIVE_WINDOW_MS;
        return {
          courtNumber,
          label: info.label,
          color: info.color,
          count: countByCourt.get(courtNumber) ?? 0,
          isActive: info.hasLiveChat || recentlyActive,
          isHidden: hiddenCourts.has(courtNumber)
        };
      })
      .sort((a, b) => a.courtNumber - b.courtNumber);
  }, [courts, messages, countByCourt, latestByCourt, hiddenCourts, nowMs]);

  const liveCount = chips.filter((c) => c.isActive).length;
  const totalStreams = courts.length || chips.length;

  const toggleCourt = useCallback((courtNumber: number) => {
    setHiddenCourts((prev) => {
      const next = new Set(prev);
      if (next.has(courtNumber)) next.delete(courtNumber);
      else next.add(courtNumber);
      return next;
    });
  }, []);

  const visibleMessages = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (m.courtNumber != null && hiddenCourts.has(m.courtNumber)) return false;
      if (!needle) return true;
      const haystack = [m.text, m.authorName ?? "", m.courtLabel ?? "", m.courtNumber != null ? `court ${m.courtNumber}` : ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [messages, hiddenCourts, search]);

  const anyVideoIds = courts.some((c) => c.hasVideoId);
  const banner = resolveBanner({ youtubeConfigured, chatEnabled, anyVideoIds, hasMessages: messages.length > 0, hasEvent: Boolean(eventId) });

  return (
    <main className="shell chat-shell">
      <div className="container chat-container stack">
        <header className="chat-header">
          <div className="chat-header-top">
            <span className="brand-mark small">Score<em>Check</em></span>
            <Link className="chat-admin-link" href="/admin/production" aria-label="Set court video IDs">
              <Settings size={16} aria-hidden="true" /> Video IDs
            </Link>
          </div>
          <div className="chat-title-row">
            <h1>Live Chat</h1>
            <span className={`chat-status ${realtimeConnected ? "live" : "poll"}`}>
              {realtimeConnected ? <Radio size={13} aria-hidden="true" /> : <WifiOff size={13} aria-hidden="true" />}
              {realtimeConnected ? "Live" : "Polling"}
            </span>
          </div>
          <p className="chat-subtitle">
            <strong>{eventName}</strong>
            <span className="chat-livecount">{liveCount} of {totalStreams} streams live</span>
            <span className="muted">· {messages.length} msg</span>
          </p>

          <div className="chat-controls">
            <label className="chat-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                inputMode="search"
                placeholder="Search messages, authors, courts…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {chips.length > 0 && (
              <div className="chat-chips" role="group" aria-label="Filter by court">
                {chips.map((chip) => (
                  <button
                    key={chip.courtNumber}
                    type="button"
                    className={`chat-chip ${chip.isHidden ? "off" : ""} ${chip.isActive ? "active" : "idle"}`}
                    style={{ ["--court-color" as string]: chip.color }}
                    aria-pressed={!chip.isHidden}
                    onClick={() => toggleCourt(chip.courtNumber)}
                    title={chip.isActive ? "Live — tap to hide" : "Idle — tap to hide"}
                  >
                    <span className="chat-chip-dot" />
                    Court {chip.courtNumber}
                    <span className="chat-chip-count">{chip.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {banner && (
          <div className={`chat-banner ${banner.tone}`} role="status">
            <p>{banner.text}</p>
            {banner.showProductionLink && (
              <Link className="button ghost" href="/admin/production">Set court video IDs</Link>
            )}
          </div>
        )}

        <div className="chat-feed-wrap">
          <div className="chat-feed" ref={feedRef} onScroll={onScroll}>
            {visibleMessages.length === 0 ? (
              <div className="chat-empty">
                <MessageSquare size={26} aria-hidden="true" />
                <p>{messages.length === 0 ? "No messages yet." : "No messages match your filters."}</p>
                {messages.length === 0 && banner == null && (
                  <p className="muted small">Messages arrive up to ~3 minutes behind live (quota throttling).</p>
                )}
              </div>
            ) : (
              visibleMessages.map((m) => (
                <article className="chat-msg" key={m.id || m.youtubeMessageId}>
                  <span className="chat-badge" style={{ ["--court-color" as string]: courtColor(m.courtNumber) }}>
                    <span className="chat-badge-num">Court {m.courtNumber ?? "?"}</span>
                    {m.courtLabel && m.courtLabel !== `Court ${m.courtNumber}` && (
                      <span className="chat-badge-label">{m.courtLabel}</span>
                    )}
                  </span>
                  <div className="chat-msg-body">
                    <div className="chat-msg-meta">
                      <span className={`chat-author ${m.isOwner ? "owner" : m.isModerator ? "mod" : ""}`}>
                        {m.authorName || "Viewer"}
                        {m.isOwner && <span className="chat-tag owner">OWNER</span>}
                        {!m.isOwner && m.isModerator && <span className="chat-tag mod">MOD</span>}
                      </span>
                      <time className="chat-time">{relativeTime(m.publishedAt ?? m.createdAt, nowMs)}</time>
                    </div>
                    <p className="chat-text">{m.text}</p>
                  </div>
                </article>
              ))
            )}
          </div>
          {!autoScroll && visibleMessages.length > 0 && (
            <button type="button" className="chat-jump" onClick={jumpToLatest}>
              <ArrowDown size={15} aria-hidden="true" /> Jump to latest
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

type Banner = { text: string; tone: "warn" | "info"; showProductionLink: boolean };

function resolveBanner(input: {
  youtubeConfigured: boolean;
  chatEnabled: boolean;
  anyVideoIds: boolean;
  hasMessages: boolean;
  hasEvent: boolean;
}): Banner | null {
  if (!input.hasEvent) {
    return { text: "No active event. Activate an event in the admin console to start monitoring chat.", tone: "warn", showProductionLink: false };
  }
  if (!input.youtubeConfigured) {
    return {
      text: "YouTube API not configured. Set YOUTUBE_API_KEY (or the OAuth vars) and enable YOUTUBE_CHAT_ENABLED so the worker can read live chat.",
      tone: "warn",
      showProductionLink: false
    };
  }
  if (!input.chatEnabled) {
    return { text: "Chat polling is disabled. Set YOUTUBE_CHAT_ENABLED=true so the worker starts reading live chat.", tone: "warn", showProductionLink: false };
  }
  if (!input.anyVideoIds) {
    return { text: "No court video IDs are set yet. Add each court's YouTube video ID so its chat can be monitored.", tone: "info", showProductionLink: true };
  }
  if (!input.hasMessages) {
    return { text: "Waiting for the first messages… (up to ~3 minutes behind live due to quota throttling).", tone: "info", showProductionLink: false };
  }
  return null;
}

/** Defensively map a realtime row (snake_case, loosely typed) to a DTO. */
function coerceRealtimeRow(raw: Record<string, unknown> | undefined): ChatMessageDto | null {
  if (!raw) return null;
  const youtubeMessageId = typeof raw.youtube_message_id === "string" ? raw.youtube_message_id : "";
  if (!youtubeMessageId) return null;
  const text = typeof raw.message_text === "string" ? raw.message_text : "";
  return {
    id: typeof raw.id === "string" ? raw.id : youtubeMessageId,
    youtubeMessageId,
    courtNumber: typeof raw.court_number === "number" ? raw.court_number : null,
    courtLabel: typeof raw.court_label === "string" ? raw.court_label : null,
    authorName: typeof raw.author_name === "string" ? raw.author_name : null,
    isModerator: raw.is_moderator === true,
    isOwner: raw.is_owner === true,
    text,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString()
  };
}

function sortKey(m: ChatMessageDto): number {
  const published = Date.parse(m.publishedAt ?? "");
  if (Number.isFinite(published)) return published;
  const created = Date.parse(m.createdAt);
  return Number.isFinite(created) ? created : 0;
}
