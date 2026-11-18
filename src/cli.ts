// Try a tool from the terminal without any MCP client:
//   node src/cli.ts next_departures '{"station":"secaucus"}'
//   node src/cli.ts list
//   node src/cli.ts token      (prints a new NJ Transit token; uses 1 of your 5 a day)
import { readConfig, makeSource } from "./config.ts";
import { callTool, TOOLS } from "./tools.ts";
import { MemoryKV } from "./cache.ts";

const [name, rawArgs] = process.argv.slice(2);
if (!name || name === "list") {
  for (const t of TOOLS) console.log(`${t.name}: ${t.description}\n`);
  process.exit(0);
}
const cfg = readConfig(process.env as Record<string, unknown>, new MemoryKV());
if (name === "token") {
  const { NjtLiveSource } = await import("./njt.ts");
  const src = new NjtLiveSource({ ...cfg, njtToken: undefined });
  console.log(await src.freshToken());
  process.exit(0);
}
const result = await callTool(name, rawArgs ? JSON.parse(rawArgs) : {}, { source: makeSource(cfg), now: Date.now });
console.log(result.content.map((c) => c.text).join("\n"));
if (result.isError) process.exit(1);
