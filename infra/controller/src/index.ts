/**
 * BVM production controller — Phase 3 skeleton (docs/PRODUCTION_PLATFORM_PLAN.md §3.6).
 *
 * A small always-on service (Docker, on the base droplet) that exposes an
 * authenticated REST surface for /admin/production. Today it only wraps the
 * LiveKit Egress API (start/stop/list per court); DigitalOcean fleet control
 * and health relaying land in Phase 3 (see TODOs at the bottom).
 *
 * Routes (all except /health require `Authorization: Bearer $CONTROLLER_TOKEN`):
 *   GET  /health           liveness (unauthenticated, for container checks)
 *   GET  /courts           active egresses mapped to courts
 *   POST /courts/:n/start  StartWebEgress for court n's program page
 *                          body (optional): { "youtubeKey": "...", "preset": "H264_1080P_30" }
 *   POST /courts/:n/stop   StopEgress for court n
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  EgressClient,
  EgressStatus,
  EncodingOptionsPreset,
  StreamOutput,
  StreamProtocol,
} from 'livekit-server-sdk';
import type { EgressInfo } from 'livekit-server-sdk';

// --- configuration (fail fast on missing secrets) ----------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required env var ${name} (see .env.example)`);
  }
  return value;
}

const config = {
  port: Number.parseInt(process.env.CONTROLLER_PORT ?? '8080', 10),
  /** Bearer token expected from /admin/production (via its server-side proxy). */
  controllerToken: requireEnv('CONTROLLER_TOKEN'),
  /** LiveKit Egress API — the compositor stack in infra/compositor. */
  livekitUrl: process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880',
  livekitApiKey: requireEnv('LIVEKIT_API_KEY'),
  livekitApiSecret: requireEnv('LIVEKIT_API_SECRET'),
  /** Court N's scene: `${programPageBaseUrl}/${n}?token=${programPageToken}` */
  programPageBaseUrl: requireEnv('PROGRAM_PAGE_BASE_URL'),
  programPageToken: requireEnv('PROGRAM_PAGE_TOKEN'),
  youtubeRtmpBase: process.env.YOUTUBE_RTMP_BASE ?? 'rtmp://a.rtmp.youtube.com/live2',
};

const egress = new EgressClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);

// --- helpers ------------------------------------------------------------------

/** Program-page URL for a court (the scene the egress captures). */
function programPageUrl(court: number): string {
  return `${config.programPageBaseUrl}/${court}?token=${config.programPageToken}`;
}

/** Same URL with the token blanked, safe for logs/API responses. */
function redactedProgramPageUrl(court: number): string {
  return `${config.programPageBaseUrl}/${court}?token=<redacted>`;
}

const PRESETS: Record<string, EncodingOptionsPreset> = {
  H264_720P_30: EncodingOptionsPreset.H264_720P_30,
  H264_1080P_30: EncodingOptionsPreset.H264_1080P_30,
};

/** Best-effort reverse map: which court does an active egress belong to? */
function courtForEgress(info: EgressInfo): number | undefined {
  if (info.request.case !== 'web') return undefined;
  const match = info.request.value.url.match(/\/(\d+)(?:\?|$)/);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
}

function egressSummary(info: EgressInfo): Record<string, unknown> {
  return {
    egressId: info.egressId,
    court: courtForEgress(info) ?? null,
    status: EgressStatus[info.status] ?? String(info.status),
    startedAt: info.startedAt > 0n ? new Date(Number(info.startedAt / 1_000_000n)).toISOString() : null,
    error: info.error === '' ? null : info.error,
  };
}

async function findActiveEgressForCourt(court: number): Promise<EgressInfo | undefined> {
  const active = await egress.listEgress({ active: true });
  return active.find((info) => courtForEgress(info) === court);
}

/**
 * Last-started egress id per court (in-memory only — a restart forgets it, and
 * findActiveEgressForCourt covers that case).
 * TODO(phase-3): persist court state to Supabase so /admin/production and the
 * heartbeat/health board share one source of truth (plan §3.5-3.6).
 */
const courtEgressIds = new Map<number, string>();

// --- middleware -----------------------------------------------------------------

/** Constant-time bearer-token check (hash both sides to equalize lengths). */
function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const expected = createHash('sha256').update(config.controllerToken).digest();
  const actual = createHash('sha256').update(presented).digest();
  if (presented === '' || !timingSafeEqual(expected, actual)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function parseCourt(req: Request, res: Response): number | undefined {
  // express 5 types params as string | string[] (arrays only for wildcard
  // routes, which we don't use — treat anything else as invalid).
  const raw = req.params.n;
  const n = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    res.status(400).json({ error: 'court number must be an integer 1-99' });
    return undefined;
  }
  return n;
}

// --- app ------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'bvm-production-controller', uptimeSec: Math.round(process.uptime()) });
});

const courts = express.Router();
courts.use(bearerAuth);

/** Active egresses, court-mapped — the console's court-grid data source. */
courts.get('/', async (_req: Request, res: Response) => {
  const active = await egress.listEgress({ active: true });
  res.json({ courts: active.map(egressSummary) });
});

/** Start the broadcast for court :n (web egress capturing the program page). */
courts.post('/:n/start', async (req: Request, res: Response) => {
  const court = parseCourt(req, res);
  if (court === undefined) return;

  const body = (req.body ?? {}) as { youtubeKey?: string; preset?: string };

  // Stream key: request body wins; else per-court env (Phase 3 moves these to
  // Supabase `courts.youtube_stream_key`, encrypted — plan §3.4).
  const youtubeKey = body.youtubeKey ?? process.env[`COURT_${court}_YOUTUBE_KEY`];
  if (youtubeKey === undefined || youtubeKey === '') {
    res.status(400).json({ error: `no YouTube key: pass "youtubeKey" or set COURT_${court}_YOUTUBE_KEY` });
    return;
  }

  const presetName = body.preset ?? process.env.EGRESS_PRESET ?? 'H264_720P_30';
  const preset = PRESETS[presetName];
  if (preset === undefined) {
    res.status(400).json({ error: `unknown preset "${presetName}"`, supported: Object.keys(PRESETS) });
    return;
  }

  const existing = await findActiveEgressForCourt(court);
  if (existing !== undefined) {
    res.status(409).json({ error: `court ${court} already live`, egress: egressSummary(existing) });
    return;
  }

  const info = await egress.startWebEgress(
    programPageUrl(court),
    { stream: new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [`${config.youtubeRtmpBase}/${youtubeKey}`] }) },
    {
      // Hold capture until the page logs START_RECORDING (WHEP + audio up).
      awaitStartSignal: true,
      encodingOptions: preset,
    },
  );
  courtEgressIds.set(court, info.egressId);
  console.log(`court ${court}: started egress ${info.egressId} for ${redactedProgramPageUrl(court)}`);
  res.status(202).json({ court, egress: egressSummary(info) });
});

/** Stop the broadcast for court :n. */
courts.post('/:n/stop', async (req: Request, res: Response) => {
  const court = parseCourt(req, res);
  if (court === undefined) return;

  const egressId = courtEgressIds.get(court) ?? (await findActiveEgressForCourt(court))?.egressId;
  if (egressId === undefined) {
    res.status(404).json({ error: `no active egress found for court ${court}` });
    return;
  }

  const info = await egress.stopEgress(egressId);
  courtEgressIds.delete(court);
  console.log(`court ${court}: stopped egress ${egressId}`);
  res.json({ court, egress: egressSummary(info) });
});

app.use('/courts', courts);

// TODO(phase-3): DigitalOcean fleet control (plan §3.5 "event-day infra panel", §6 phase 5):
//   POST /fleet/provision + POST /fleet/teardown — DO REST calls mirroring
//   infra/compositor/provision.sh / teardown.sh (create from snapshot, cloud-init,
//   tag bvm-compositor, reserved-IP reassignment), with boot-progress reporting.
// TODO(phase-3): health relay — poll egress Prometheus (:9090), MediaMTX path stats
//   (127.0.0.1:9997) and program-page heartbeats into Supabase for the health board.
// TODO(phase-3): YouTube key storage moves from env to Supabase (encrypted); this
//   service becomes the only reader.

// Surface async handler failures as JSON (express 5 routes rejected promises here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('unhandled error:', message);
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`bvm-production-controller listening on :${config.port} (egress api: ${config.livekitUrl})`);
});
