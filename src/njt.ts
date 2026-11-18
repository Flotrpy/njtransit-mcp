import { Cache } from "./cache.ts";
import { etDateKey } from "./time.ts";
import type {
  Config,
  RailSource,
  Station,
  StationBoard,
  StationMessage,
  TrainStopList,
} from "./types.ts";

const PROD_BASE = "https://raildata.njtransit.com/api/TrainData";
const TEST_BASE = "https://testraildata.njtransit.com/api/TrainData";

/** NJ Transit lets an account make 5 tokens a day. We stop at 4 to leave one for you. */
const MAX_TOKENS_PER_DAY = 4;

/** How long each kind of answer stays cached, in seconds. */
export const TTL = {
  stations: 24 * 60 * 60,
  board: 30,
  boardWithStops: 60,
  trainStops: 30,
  alerts: 120,
  token: 7 * 24 * 60 * 60,
};

export class NjtError extends Error {}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Client for NJ Transit's RailData API (free; needs a developer account).
 * Every method is a POST with multipart form fields; the token goes in a
 * form field named "token". Tokens are cached (in KV when available) because
 * NJ Transit allows only 5 new ones per account per day.
 */
export class NjtLiveSource implements RailSource {
  readonly mode = "live" as const;
  private base: string;
  private cache: Cache;
  private cfg: Config;
  private fetchFn: FetchLike;
  private now: () => number;

  constructor(cfg: Config, opts: { fetch?: FetchLike; now?: () => number; cache?: Cache } = {}) {
    this.cfg = cfg;
    this.base = cfg.useTestApi ? TEST_BASE : PROD_BASE;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.cache = opts.cache ?? new Cache(cfg.kv, this.now);
  }

  stations(): Promise<Station[]> {
    return this.cache.getOrLoad("njt:stations", TTL.stations, () => this.call<Station[]>("getStationList", {}), true);
  }

  departures(station: string): Promise<StationBoard> {
    return this.cache.getOrLoad(`njt:board19:${station}`, TTL.board, () =>
      this.call<StationBoard>("getTrainSchedule19Rec", { station }),
    );
  }

  boardWithStops(station: string): Promise<StationBoard> {
    return this.cache.getOrLoad(`njt:board:${station}`, TTL.boardWithStops, () =>
      this.call<StationBoard>("getTrainSchedule", { station }),
    );
  }

  trainStops(trainId: string): Promise<TrainStopList> {
    return this.cache.getOrLoad(`njt:train:${trainId}`, TTL.trainStops, () =>
      this.call<TrainStopList>("getTrainStopList", { train: trainId }),
    );
  }

  alerts(station?: string): Promise<StationMessage[]> {
    const fields: Record<string, string> = {};
    if (station) fields.station = station;
    return this.cache.getOrLoad(`njt:msg:${station ?? "*"}`, TTL.alerts, async () => {
      const r = await this.call<StationMessage[] | null>("getStationMSG", fields);
      return r ?? [];
    });
  }

  // ---- token handling ----

  /** Get a brand-new token (for `npm run try -- token`, to save as NJT_TOKEN on hosts without KV). */
  freshToken(): Promise<string> {
    return this.newToken();
  }

  private async token(): Promise<string> {
    const cached = await this.cache.get<string>("njt:token");
    if (cached) return cached;
    if (this.cfg.njtToken) return this.cfg.njtToken;
    return this.newToken();
  }

  private async newToken(): Promise<string> {
    if (!this.cfg.njtUsername || !this.cfg.njtPassword) {
      throw new NjtError(
        "Can't get an NJ Transit token: NJT_USERNAME and NJT_PASSWORD aren't set (or the saved token stopped working).",
      );
    }
    const countKey = `njt:tokencount:${etDateKey(this.now())}`;
    const used = (await this.cache.get<number>(countKey)) ?? 0;
    if (used >= MAX_TOKENS_PER_DAY) {
      throw new NjtError(
        `Already requested ${used} NJ Transit tokens today (the limit is 5 a day). Try again after midnight Eastern.`,
      );
    }
    await this.cache.set(countKey, used + 1, 26 * 60 * 60, true);

    const res = await this.post("getToken", {
      username: this.cfg.njtUsername,
      password: this.cfg.njtPassword,
    });
    const body = (await res.json().catch(() => ({}))) as { Authenticated?: string; UserToken?: string; errorMessage?: string };
    if (!res.ok || String(body.Authenticated).toLowerCase() !== "true" || !body.UserToken) {
      throw new NjtError(
        `NJ Transit didn't accept the username and password${body.errorMessage ? `: ${body.errorMessage}` : ""}.`,
      );
    }
    await this.cache.set("njt:token", body.UserToken, TTL.token, true);
    return body.UserToken;
  }

  // ---- HTTP ----

  private post(method: string, fields: Record<string, string>): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return this.fetchFn(`${this.base}/${method}`, {
      method: "POST",
      headers: { accept: "text/plain" },
      body: form,
    });
  }

  /** Call a RailData method with the token, refreshing the token once if NJ Transit says it's invalid. */
  async call<T>(method: string, fields: Record<string, string>, retried = false): Promise<T> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.post(method, { token, ...fields });
    } catch (e) {
      throw new NjtError(`Couldn't reach NJ Transit (${(e as Error).message}).`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new NjtError(`NJ Transit sent something that isn't JSON (HTTP ${res.status}).`);
    }
    const errMsg =
      body && typeof body === "object" && !Array.isArray(body) ? (body as { errorMessage?: string }).errorMessage : undefined;
    if (errMsg && /invalid token/i.test(errMsg) && !retried) {
      await this.cache.delete("njt:token");
      this.cfg = { ...this.cfg, njtToken: undefined };
      await this.newToken();
      return this.call<T>(method, fields, true);
    }
    if (!res.ok || errMsg) {
      throw new NjtError(`NJ Transit returned an error for ${method}: ${errMsg ?? `HTTP ${res.status}`}.`);
    }
    return body as T;
  }
}
