"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export function ProgramBootstrapClient() {
  const searchParams = useSearchParams();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = fragment.get("token");
    const body = {
      token,
      court: searchParams.get("court"),
      build: searchParams.get("build"),
      deployment: searchParams.get("deployment"),
      cbuf: searchParams.get("cbuf"),
      scene: searchParams.get("scene"),
      debug: searchParams.get("debug")
    };
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void fetch("/api/program/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin"
    }).then(async (response) => {
      if (!response.ok) throw new Error("authorization rejected");
      const value = await response.json();
      if (typeof value?.next !== "string" || !value.next.startsWith("/program/court/")) throw new Error("invalid destination");
      window.location.replace(value.next);
    }).catch(() => setFailed(true));
  }, [searchParams]);

  return <main>{failed ? "Program scene authorization failed." : "Preparing program scene..."}</main>;
}
