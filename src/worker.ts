// Cloudflare Workers entry point (free plan works; no card needed).
import { readConfig, makeSource } from "./config.ts";
import { createApp, type App } from "./mcp.ts";
import type { KVLike } from "./types.ts";

interface Env {
  NJT_USERNAME?: string;
  NJT_PASSWORD?: string;
  NJT_TOKEN?: string;
  NJT_USE_TEST_API?: string;
  MOCK_MODE?: string;
  MCP_ACCESS_KEY?: string;
  ALLOWED_ORIGINS?: string;
  /** Optional KV namespace that keeps the NJ Transit token across restarts. */
  CACHE?: KVLike;
}

// One app per Worker isolate, so the in-memory cache is reused between requests.
let app: App | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!app) {
      const cfg = readConfig(env as unknown as Record<string, unknown>, env.CACHE);
      app = createApp(makeSource(cfg), cfg);
    }
    return app.fetch(req);
  },
};
