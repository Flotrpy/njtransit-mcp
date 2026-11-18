// Turning what a person types ("secaucus", "penn station ny", "coast line")
// into NJ Transit station codes and lines.

import type { ScheduleItem, Station } from "./types.ts";

/** Common names people use that don't look like the official station name. */
const STATION_ALIASES: Record<string, string[]> = {
  NY: ["nyc", "new york", "nyp", "penn station", "ny penn", "penn station new york", "manhattan", "midtown"],
  NP: ["newark", "newark penn", "nwk"],
  SE: ["secaucus", "secaucus junction", "frank r lautenberg", "secaucus upper"],
  TS: ["secaucus lower"],
  NA: ["ewr", "newark airport", "newark liberty", "airport"],
  ND: ["broad street", "newark broad"],
  HB: ["hoboken terminal"],
  PJ: ["princeton jct", "princeton junction", "west windsor"],
  PR: ["princeton university", "dinky"],
  TR: ["trenton transit center"],
  MP: ["metropark", "iselin"],
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\b\.?/g, "street")
    .replace(/\bjct\b\.?/g, "junction")
    .replace(/\blvl\b\.?/g, "level")
    .replace(/\bsta\b\.?/g, "station")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}

export interface StationMatch {
  station: Station;
  score: number; // 0-100
}

/** Rank stations against a query. Best first. */
export function searchStations(stations: Station[], query: string, limit = 5): StationMatch[] {
  const raw = query.trim();
  const q = normalize(raw);
  if (!q) return [];
  const qTokens = q.split(" ");
  const scored: StationMatch[] = [];
  for (const st of stations) {
    const code = st.STATION_2CHAR.toUpperCase();
    const name = normalize(st.STATIONNAME);
    let score = 0;
    if (raw.toUpperCase() === code) score = 100;
    else if (name === q) score = 98;
    else {
      const aliases = (STATION_ALIASES[code] ?? []).map(normalize);
      const qTight = q.replace(/ /g, "");
      const nameTight = name.replace(/ /g, "");
      if (aliases.includes(q)) score = 96;
      else if (qTight === nameTight) score = 95; // "metro park" vs "Metropark"
      else if (name.startsWith(q)) score = 90;
      else if (qTight.length >= 4 && nameTight.startsWith(qTight)) score = 85;
      else {
        const nameTokens = name.split(" ");
        const allPrefix = qTokens.every((t) => nameTokens.some((n) => n.startsWith(t)));
        if (allPrefix) score = 80;
        else if (aliases.some((a) => a.startsWith(q) || q.startsWith(a))) score = 75;
        const sim = Math.max(similarity(q, name), ...aliases.map((a) => similarity(q, a)));
        score = Math.max(score, Math.round(sim * 70));
      }
    }
    if (score >= 25) scored.push({ station: st, score });
  }
  scored.sort((a, b) => b.score - a.score || a.station.STATIONNAME.localeCompare(b.station.STATIONNAME));
  return scored.slice(0, limit);
}

export class StationNotFound extends Error {}

/**
 * Pick one station for a query, or explain what's ambiguous. A clear winner is
 * either an exact code/name/alias, or a match well ahead of the runner-up.
 */
export function resolveStation(stations: Station[], query: string): Station {
  const matches = searchStations(stations, query, 5);
  if (!matches.length) {
    throw new StationNotFound(`No NJ Transit station matches "${query}". Try find_station with part of the name.`);
  }
  const [best, second] = matches;
  if (best.score >= 96 || best.score >= 60 && (!second || best.score - second.score >= 10)) return best.station;
  // Several stations starting with the same word (e.g. "Newark ...") with no alias: ask.
  const options = matches.map((m) => `${m.station.STATIONNAME} (${m.station.STATION_2CHAR})`).join(", ");
  throw new StationNotFound(`"${query}" could mean several stations: ${options}. Pass the 2-letter code to pick one.`);
}

/** Line nicknames → words that appear in NJ Transit's LINE / LINEABBREVIATION fields. */
const LINE_ALIASES: [string[], string[]][] = [
  [["nec", "northeast corridor", "northeast", "ne corridor", "corridor"], ["nec", "northeast"]],
  [["njcl", "north jersey coast", "coast", "coast line", "jersey coast"], ["njcl", "coast"]],
  [["m and e", "me", "morris and essex", "morristown", "morristown line"], ["m and e", "morristown", "me line"]],
  [["gladstone", "gladstone branch"], ["gladstone", "glad"]],
  [["montclair", "boonton", "montclair boonton", "mobo"], ["montclair", "boonton", "mobo"]],
  [["raritan", "raritan valley", "rvl", "rarv"], ["raritan", "rarv", "rvl"]],
  [["main", "main line"], ["main"]],
  [["bergen", "bergen county", "bergen county line"], ["bergen", "berg"]],
  [["pascack", "pascack valley", "pvl"], ["pascack", "pasc"]],
  [["atlantic city", "acl", "atlantic city line", "ac line"], ["atl", "atlantic", "acrl"]],
  [["princeton", "dinky", "princeton shuttle"], ["princeton", "prin"]],
  [["amtrak"], ["amtrak", "amtk"]],
  [["port jervis"], ["port jervis"]],
  [["mbpj", "meadowlands"], ["meadowlands"]],
];

/** Does a train belong to the line the person named? */
export function matchesLine(item: Pick<ScheduleItem, "LINE" | "LINEABBREVIATION" | "LINECODE">, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize(`${item.LINE ?? ""} ${item.LINEABBREVIATION ?? ""} ${item.LINECODE ?? ""}`);
  if (hay.includes(q)) return true;
  for (const [names, words] of LINE_ALIASES) {
    if (names.includes(q) || names.some((n) => n.length > 3 && q.includes(n))) {
      return words.some((w) => hay.split(" ").includes(w) || (w.length > 3 && hay.includes(w)));
    }
  }
  return false;
}

/** Does a destination string match what the person typed? (loose, for filtering) */
export function matchesText(value: string | undefined, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const v = normalize(value ?? "");
  if (v.includes(q)) return true;
  return q.split(" ").every((t) => v.split(" ").some((w) => w.startsWith(t)));
}
