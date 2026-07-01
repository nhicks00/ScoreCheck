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
        play: () => void;
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
    setStatus("Preview ready");
  }, [courtNumber, enabled, sessionToken]);

  useEffect(() => {
    if (!enabled) return;
    void loadToken();
    const id = window.setInterval(loadToken, 8 * 60_000);
    return () => window.clearInterval(id);
  }, [enabled, loadToken]);

  useEffect(() => {
    if (!playbackUrl || !videoRef.current) return;
    const video = videoRef.current;
    if (window.IVSPlayer?.isPlayerSupported) {
      playerRef.current?.delete?.();
      const player = window.IVSPlayer.create();
      player.attachHTMLVideoElement(video);
      player.load(playbackUrl);
      void video.play().catch(() => setStatus("Tap play to start preview."));
      playerRef.current = player;
    } else {
      video.src = playbackUrl;
      void video.play().catch(() => setStatus("Tap play to start preview."));
    }
    return () => {
      playerRef.current?.delete?.();
      playerRef.current = null;
    };
  }, [playbackUrl]);

  useEffect(() => {
    if (!enabled || window.IVSPlayer) return;
    const script = document.createElement("script");
    script.src = "https://player.live-video.net/1.31.0/amazon-ivs-player.min.js";
    script.async = true;
    document.head.appendChild(script);
    return () => {
      script.remove();
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
