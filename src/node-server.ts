// Node entry point: `npm start` locally, or on Render's free web service.
import { createServer } from "node:http";
import { readConfig, makeSource } from "./config.ts";
import { createApp } from "./mcp.ts";
import { MemoryKV } from "./cache.ts";

const cfg = readConfig(process.env as Record<string, unknown>, new MemoryKV());
const source = makeSource(cfg);
const app = createApp(source, cfg);
const port = Number(process.env.PORT ?? 8787);
// Bind to localhost by default; set HOST=0.0.0.0 on a host like Render.
const host = process.env.HOST ?? "127.0.0.1";

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
      method: req.method,
      headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Server error: ${(e as Error).message}`);
  }
}).listen(port, host, () => {
  console.log(`NJ Transit MCP server (${source.mode} data) on http://${host}:${port}/mcp`);
});
