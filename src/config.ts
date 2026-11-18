import { MockSource } from "./mock.ts";
import { NjtLiveSource } from "./njt.ts";
import type { Config, KVLike, RailSource } from "./types.ts";

/** Read settings from environment variables (Cloudflare `env` or Node `process.env`). */
export function readConfig(env: Record<string, unknown>, kv?: KVLike): Config {
  const s = (k: string) => {
    const v = env[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const yes = (k: string) => /^(1|true|yes|on)$/i.test(s(k) ?? "");
  return {
    njtUsername: s("NJT_USERNAME"),
    njtPassword: s("NJT_PASSWORD"),
    njtToken: s("NJT_TOKEN"),
    useTestApi: yes("NJT_USE_TEST_API"),
    forceMock: yes("MOCK_MODE"),
    accessKey: s("MCP_ACCESS_KEY"),
    allowedOrigins: (s("ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    kv,
  };
}

/** Live NJ Transit data when credentials are set, otherwise built-in sample data. */
export function makeSource(cfg: Config): RailSource {
  const hasCreds = Boolean(cfg.njtToken || (cfg.njtUsername && cfg.njtPassword));
  return hasCreds && !cfg.forceMock ? new NjtLiveSource(cfg) : new MockSource();
}
