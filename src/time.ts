// Time helpers. NJ Transit returns wall-clock times in Eastern time,
// e.g. "18-Nov-2026 02:15:00 PM". Everything we show the user is Eastern too.

export const TZ = "America/New_York";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** Wall-clock parts of an instant, in Eastern time. */
export function etParts(epochMs: number): Parts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of Eastern time from UTC at an instant, in ms (e.g. -5h in winter). */
function etOffsetMs(epochMs: number): number {
  const p = etParts(epochMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Convert an Eastern wall-clock time to an epoch instant. */
export function etWallToEpoch(p: Parts): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let epoch = guess - etOffsetMs(guess);
  // Second pass settles times near a DST switch.
  epoch = guess - etOffsetMs(epoch);
  return epoch;
}

/**
 * Parse a time string from NJ Transit. Accepts:
 *  - "18-Nov-2026 02:15:00 PM" (Eastern wall time, the usual RailData format)
 *  - "11/18/2026 2:15:00 PM" (Eastern wall time)
 *  - ISO strings with a zone, e.g. "2026-11-18T19:15:00Z"
 * Returns epoch ms, or undefined when the string can't be read.
 */
export function parseNjtTime(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const str = String(s).trim();
  if (!str) return undefined;

  let m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (month === 0) return undefined;
    return etWallToEpoch({
      year: Number(m[3]),
      month,
      day: Number(m[1]),
      hour: to24(Number(m[4]), m[7]),
      minute: Number(m[5]),
      second: Number(m[6] ?? 0),
    });
  }

  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (m) {
    return etWallToEpoch({
      year: Number(m[3]),
      month: Number(m[1]),
      day: Number(m[2]),
      hour: to24(Number(m[4]), m[7]),
      minute: Number(m[5]),
      second: Number(m[6] ?? 0),
    });
  }

  // ISO with explicit zone.
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) && /(Z|[+-]\d{2}:?\d{2})$/.test(str)) {
    const t = Date.parse(str);
    return Number.isNaN(t) ? undefined : t;
  }
  // ISO without a zone: treat as Eastern wall time.
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return etWallToEpoch({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] ?? 0),
    });
  }
  return undefined;
}

function to24(h: number, ampm?: string): number {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === "pm";
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

const clockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "2:15 PM" in Eastern time. */
export function formatClock(epochMs: number): string {
  return clockFormatter.format(new Date(epochMs));
}

/** "Wed, Nov 18, 2:15 PM" in Eastern time. */
export function formatDayClock(epochMs: number): string {
  return `${dayFormatter.format(new Date(epochMs))}, ${formatClock(epochMs)}`;
}

/** Format an instant the way RailData does: "18-Nov-2026 02:15:00 PM". */
export function formatNjtTime(epochMs: number): string {
  const p = etParts(epochMs);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  const mon = MONTHS[p.month - 1];
  return `${pad(p.day)}-${mon[0].toUpperCase()}${mon.slice(1)}-${p.year} ${pad(h12)}:${pad(p.minute)}:${pad(p.second)} ${ampm}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "in 5 min", "now", "2 min ago", "in 1 hr 10 min". */
export function relativeMinutes(targetMs: number, nowMs: number): string {
  const mins = Math.round((targetMs - nowMs) / 60000);
  if (mins === 0) return "now";
  const abs = Math.abs(mins);
  const text = abs >= 60 ? `${Math.floor(abs / 60)} hr${abs % 60 ? ` ${abs % 60} min` : ""}` : `${abs} min`;
  return mins > 0 ? `in ${text}` : `${text} ago`;
}

/** "42 min" or "1 hr 5 min". */
export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ""}`;
}

/** Today's date in Eastern time as "2026-11-18" (used for daily counters). */
export function etDateKey(epochMs: number): string {
  const p = etParts(epochMs);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
