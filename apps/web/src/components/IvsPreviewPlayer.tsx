"use client";

import { Play, RefreshCw, VideoOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type IvsPreviewPlayerProps = {
  sessionToken: string;
  courtNumber: number;
  enabled: boolean;
};

declare global {
  interface Window {
    IVSPlayer?: {
      isPlayerSupported: boolean;
      create: () => {
        attachHTMLVideoElement: (element: HTMLVideoElement) => void;
        load: (url: string) => void;
        play: () => void | Promise<void>;
        delete?: () => void;
      };
    };
  }
}

export function IvsPreviewPlayer({ sessionToken, courtNumber, enabled }: IvsPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<ReturnType<NonNullable<typeof window.IVSPlayer>["create"]> | null>(null);
  const [status, setStatus] = useState("Loading preview...");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);

  const loadToken = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    setStatus("Loading preview...");
    const res = await fetch("/api/video/ivs-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionToken, courtNumber })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPlaybackUrl(null);
      setStatus("Preview video is not available yet.");
      setError(json.error ?? "Preview video is not available yet.");
      return;
    }
    setPlaybackUrl(json.playbackUrl);
    setStatus(playerReady ? "Preview ready" : "Loading video player...");
  }, [courtNumber, enabled, playerReady, sessionToken]);

  useEffect(() => {
    if (!enabled) return;
    void loadToken();
    const id = window.setInterval(loadToken, 8 * 60_000);
    return () => window.clearInterval(id);
  }, [enabled, loadToken]);

  useEffect(() => {
    if (!enabled || !playbackUrl || !videoRef.current) return;
    const video = videoRef.current;
    playerRef.current?.delete?.();
    playerRef.current = null;

    if (!playerReady) {
      setStatus("Loading video player...");
      return;
    }

    if (window.IVSPlayer?.isPlayerSupported) {
      const player = window.IVSPlayer.create();
      player.attachHTMLVideoElement(video);
      player.load(playbackUrl);
      playerRef.current = player;
      setStatus("Preview ready");
      void Promise.resolve(player.play()).catch(() => setStatus("Tap play to start preview."));
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      setStatus("Preview ready");
      void video.play().catch(() => setStatus("Tap play to start preview."));
    } else {
      setPlaybackUrl(null);
      setStatus("Preview video is not available in this browser.");
      setError("Preview video is not available in this browser.");
    }
    return () => {
      playerRef.current?.delete?.();
      playerRef.current = null;
    };
  }, [enabled, playbackUrl, playerReady]);

  useEffect(() => {
    if (!enabled) {
      setPlayerReady(false);
      return;
    }
    if (window.IVSPlayer) {
      setPlayerReady(true);
      return;
    }
    let cancelled = false;
    let script = document.querySelector<HTMLScriptElement>("script[data-amazon-ivs-player]");
    if (!script) {
      script = document.createElement("script");
      script.src = "https://player.live-video.net/1.31.0/amazon-ivs-player.min.js";
      script.async = true;
      script.dataset.amazonIvsPlayer = "true";
      document.head.appendChild(script);
    }
    const onLoad = () => {
      if (!cancelled) setPlayerReady(Boolean(window.IVSPlayer));
    };
    const onError = () => {
      if (cancelled) return;
      setPlayerReady(false);
      setStatus("Preview video player could not load.");
      setError("Preview video player could not load.");
    };
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    return () => {
      cancelled = true;
      script?.removeEventListener("load", onLoad);
      script?.removeEventListener("error", onError);
    };
  }, [enabled]);

  if (!enabled) {
    return (
      <section className="video-fallback">
        <VideoOff size={22} />
        <span>Courtside mode is on.</span>
      </section>
    );
  }

  return (
    <section className="ivs-preview">
      <video ref={videoRef} playsInline muted controls crossOrigin="anonymous" />
      <div className="video-controls">
        <span>{error ?? status}</span>
        <button type="button" onClick={() => videoRef.current?.play()}>
          <Play size={16} /> Play
        </button>
        <button type="button" onClick={() => void loadToken()}>
          <RefreshCw size={16} /> Reload
        </button>
      </div>
    </section>
  );
}
