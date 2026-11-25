// A small, dependency-free MCP server over Streamable HTTP (stateless, JSON
// responses). It runs anywhere that has the web-standard Request/Response:
// Cloudflare Workers, Node 18+, Deno, Bun.
//
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

import { callTool, TOOLS, type ToolContext } from "./tools.ts";
import type { Config, RailSource } from "./types.ts";

export const SERVER_NAME = "njtransit-trains";
export const SERVER_VERSION = "0.1.8";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED_VERSIONS[0];

const INSTRUCTIONS =
  "NJ Transit commuter rail info: live departure boards, direct trips between two stations, where a " +
  "specific train is, and service alerts. All times are US Eastern. Station names can be typed naturally " +
  '("Penn Station", "Secaucus"); use find_station if a name is ambiguous. If results say SAMPLE DATA, tell ' +
  "the user the trains are made up because no NJ Transit account is connected yet.";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Constant-time string compare, so the access key can't be guessed by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Browsers send an Origin header; servers that talk to Claude's backend don't.
 * Blocking unknown browser origins prevents DNS-rebinding attacks (per the MCP spec).
 */
function originAllowed(origin: string | null, cfg: Config): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
    if (host === "claude.ai" || host.endsWith(".claude.ai") || host.endsWith(".anthropic.com")) return true;
  } catch {
    return false;
  }
  return (cfg.allowedOrigins ?? []).includes(origin);
}

export interface App {
  fetch(req: Request): Promise<Response>;
}

export function createApp(source: RailSource, cfg: Config, now: () => number = Date.now): App {
  const ctx: ToolContext = { source, now, commute: { home: cfg.commuteHome, away: cfg.commuteAway } };

  async function handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = msg.id === undefined;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isNotification ? null : rpcError(msg.id, -32600, "Invalid request");
    }
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "NJ Transit Trains", version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          result: {
            tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations: { title, ...annotations },
            })),
          },
        };
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        const result = await callTool(name, args, ctx);
        return { jsonrpc: "2.0", id: msg.id ?? null, result };
      }
      case "resources/list":
        return { jsonrpc: "2.0", id: msg.id ?? null, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id: msg.id ?? null, result: { prompts: [] } };
      default:
        if (isNotification) return null; // e.g. notifications/initialized, notifications/cancelled
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  async function handleMcp(req: Request): Promise<Response> {
    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless server: no server-to-client stream and no sessions to end.
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST", ...CORS } });
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as JsonRpcRequest[];
    if (!messages.length) return json(rpcError(null, -32600, "Empty batch"), 400);

    const responses: JsonRpcResponse[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object") {
        responses.push(rpcError(null, -32600, "Invalid request"));
        continue;
      }
      // Responses from the client (to server requests) need no reply; we never send requests.
      if (!("method" in m)) continue;
      const r = await handleMessage(m);
      if (r) responses.push(r);
    }
    if (!responses.length) return new Response(null, { status: 202, headers: CORS });
    return json(batch ? responses : responses[0]);
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (!originAllowed(req.headers.get("origin"), cfg)) return json(rpcError(null, -32003, "Forbidden origin"), 403);

      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/" || path === "/health") {
        return json({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          mode: source.mode,
          mcpEndpoint: cfg.accessKey ? "/mcp/<your access key>" : "/mcp",
          tools: TOOLS.map((t) => t.name),
        });
      }

      // The MCP endpoint is /mcp, or /mcp/<key> when an access key is set.
      const m = path.match(/^\/mcp(?:\/([^/]+))?$/);
      if (!m) return new Response("Not found", { status: 404, headers: CORS });
      if (cfg.accessKey) {
        const fromPath = m[1] ? decodeURIComponent(m[1]) : "";
        const auth = req.headers.get("authorization") ?? "";
        const fromHeader = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
        if (!safeEqual(fromPath || fromHeader, cfg.accessKey)) {
          return json(rpcError(null, -32001, "Unauthorized: wrong or missing access key"), 401);
        }
      } else if (m[1]) {
        return new Response("Not found", { status: 404, headers: CORS });
      }
      return handleMcp(req);
    },
  };
}
