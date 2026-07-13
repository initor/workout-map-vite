// scripts/fit.ts
//
// Shared FIT parsing for the importer (Strava-export corpus) and the ride sync
// (Hammerhead corpus), so both derive coordinates and the clip seed identically.
// Pure: decodes a provided byte buffer only; no filesystem, no network, no
// logging.
//
// PRIVACY: never logs coordinates or `startEpochSeconds` (the clip seed input;
// PRIVACY.md T3/T5). Callers must not log them either.

import { gunzipSync } from "node:zlib";
import { Decoder, Stream } from "@garmin/fitsdk";
import type { Coord } from "./clip.ts";

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

interface FitRecord { positionLat?: number; positionLong?: number; timestamp?: Date }
interface FitSession {
  startTime?: Date; sport?: string;
  totalDistance?: number; totalTimerTime?: number; totalCalories?: number;
  totalAscent?: number; avgHeartRate?: number; maxHeartRate?: number;
}

export interface ParsedFit {
  coords: Coord[];
  // First GPS sample's timestamp (UTC epoch seconds). SEED INPUT ONLY — the
  // cross-source ride identity (PRIVACY.md M7); never written to any artifact.
  startEpochSeconds?: number;
  sport?: string;            // FIT session sport, e.g. "cycling"
  totalDistance?: number;
  totalTimerTime?: number;
  totalCalories?: number;
  totalAscent?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
}

// Decode a FIT byte buffer, gunzipping first iff it carries the gzip magic
// (0x1f 0x8b) — so a `.fit.gz` (export) and a raw `.fit` (Hammerhead API) parse
// through the same path.
export function parseFit(buf: Uint8Array): ParsedFit {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const decoder = new Decoder(Stream.fromByteArray(new Uint8Array(raw)));
  const { messages } = decoder.read() as {
    messages: { recordMesgs?: FitRecord[]; sessionMesgs?: FitSession[] };
  };

  const coords: Coord[] = [];
  let startEpochSeconds: number | undefined;
  for (const rec of messages.recordMesgs ?? []) {
    if (rec.positionLat == null || rec.positionLong == null) continue;
    const lat = rec.positionLat * SEMICIRCLE_TO_DEG;
    const lng = rec.positionLong * SEMICIRCLE_TO_DEG;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (startEpochSeconds === undefined && rec.timestamp instanceof Date) {
      startEpochSeconds = Math.floor(rec.timestamp.getTime() / 1000);
    }
    coords.push([lng, lat]);
  }

  const session = (messages.sessionMesgs ?? [])[0];
  // Defensive fallback (positioned records normally carry a timestamp): the FIT
  // session start, which coincides with the first sample in practice.
  if (startEpochSeconds === undefined && session?.startTime instanceof Date) {
    startEpochSeconds = Math.floor(session.startTime.getTime() / 1000);
  }

  return {
    coords, startEpochSeconds, sport: session?.sport,
    totalDistance: session?.totalDistance, totalTimerTime: session?.totalTimerTime,
    totalCalories: session?.totalCalories, totalAscent: session?.totalAscent,
    avgHeartRate: session?.avgHeartRate, maxHeartRate: session?.maxHeartRate,
  };
}
