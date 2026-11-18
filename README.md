# NJ Transit Trains: an MCP connector for Claude

Ask Claude things like:

- "When's the next train from Secaucus to Penn Station?"
- "Is my 5:10 from Metropark late?"
- "What's the last train home from Penn Station to Metropark tonight?"
- "Where is train 3847 right now?"
- "Any Northeast Corridor delays?"

and get answers from NJ Transit's live rail data, with every time in Eastern.

It's a small remote MCP server (Streamable HTTP) with no runtime dependencies.
It runs free on Cloudflare Workers (no card needed), on Render's free tier, or on
your own computer. Without an NJ Transit account it runs on built-in **sample
data**, so you can try everything before signing up.

## Tools

| Tool | What it answers |
| --- | --- |
| `next_departures` | Live board for a station: times, track, delay, cancellations, crowding. Filter by line or destination. |
| `plan_trip` | Next direct trains from A to B with leave/arrive times and trip length. Says when you need to transfer. |
| `last_train` | The last direct train tonight from A to B, plus two backups. Says if NJ Transit's board doesn't reach late enough yet. |
| `train_status` | One train's stops, which it has left, where it is now, late or not, how full. |
| `service_alerts` | Current alerts, system-wide or for a station or line. |
| `find_station` | Station names to 2-letter codes. Knows nicknames like "Penn Station", "EWR", "Secaucus". |

Station names can be typed naturally; the server matches nicknames and typos.

### How it compares to what's out there

- [Transit MCP](https://transitmcp.com) covers DC, New York and the Bay Area, not NJ Transit.
- `mcp-septa` covers SEPTA only.
- One NJ Transit server listed on Glama advertises schedules with live data only for PATH.

This one is built for NJ Transit rail specifically, and adds natural station names, direct-trip planning with
arrival times, live train tracking, crowding, and caching that respects NJ Transit's limits.

## Try it in 1 minute (sample data, no account)

Needs Node.js 22.18 or newer (runs the TypeScript directly, no build step).

```bash
cd njtransit-mcp
npm test                                   # 32 tests
npm run try -- next_departures '{"station":"secaucus"}'
npm run try -- plan_trip '{"from":"metropark","to":"penn station"}'
npm start                                  # MCP server at http://127.0.0.1:8787/mcp
```

`npm run try -- list` prints every tool. To poke at the running server with a UI, use the MCP Inspector:
`npx @modelcontextprotocol/inspector` and connect to `http://127.0.0.1:8787/mcp` (transport: Streamable HTTP).

## Get live NJ Transit data (free)

1. Register for a free developer account on NJ Transit's developer portal:
   https://developer.njtransit.com/registration/ and ask for access to the **Rail Data API**.
   NJ Transit gives you a **username and password** for the API.
2. Set them as environment variables: `NJT_USERNAME` and `NJT_PASSWORD`.

That's it: the server switches from sample data to live data on its own.

Good to know about NJ Transit's API (from its terms and from the open-source `raildata` client):

- It's free. The cap is 100,000 requests a day; this server caches answers for 30 to 120 seconds, so you'll use a tiny fraction.
- An account can make only **5 tokens a day**. The server saves its token and stops itself at 4, so a bug can't lock you out.
  On Cloudflare, add the KV namespace below so the token survives restarts.
- NJ Transit wants apps to serve data from their own server (this server does) and to say data may not be real time (every answer does).
- Don't present the app as official or endorsed by NJ Transit.
- `NJT_USE_TEST_API=true` points at NJ Transit's test server instead of production.

## Deploy free on Cloudflare Workers (recommended)

Cloudflare's free plan needs no card and allows 100,000 requests a day.

### Easiest: deploy straight from GitHub (no commands)

1. In the Cloudflare dashboard, open **Workers & Pages**, select **Create application**, then **GitHub**, and let Cloudflare see this repo.
2. Pick `njtransit-mcp`. Keep the Worker name exactly `njtransit-mcp` (it must match `wrangler.toml`). Leave the build command empty;
   the deploy command is `npx wrangler deploy`. Select **Save and Deploy**.
3. Open the `https://njtransit-mcp.<your-subdomain>.workers.dev` address it shows. You should see `"mode": "mock"`.
4. In the Worker, go to **Settings → Variables and Secrets → Add**, type **Secret**, and add `MCP_ACCESS_KEY`
   (any long random text). Later add `NJT_USERNAME` and `NJT_PASSWORD` the same way to switch to live data.
5. Every push to `main` redeploys automatically.

### With the command line

```bash
npm install
npx wrangler login                          # opens a browser to sign in or sign up (free)
npx wrangler kv namespace create CACHE      # then paste the id into wrangler.toml and uncomment those lines
npx wrangler secret put NJT_USERNAME
npx wrangler secret put NJT_PASSWORD
npx wrangler secret put MCP_ACCESS_KEY      # any long random text; keeps strangers off your URL
npx wrangler deploy
```

Wrangler prints a URL like `https://njtransit-mcp.<your-subdomain>.workers.dev`.
Your connector URL is that plus `/mcp/<your MCP_ACCESS_KEY>`.

Check it: open the base URL in a browser; it shows `"mode": "live"` (or `"mock"` if the NJ Transit secrets are missing).

### Other free hosts

- **Render (free web service):** New Web Service from this folder's repo, runtime Node, build command `npm install`,
  start command `npm start`, add env vars `HOST=0.0.0.0`, `NJT_USERNAME`, `NJT_PASSWORD`, `MCP_ACCESS_KEY`.
  Free services sleep when idle, so the first question after a while takes ~30 seconds. A sleeping server forgets its
  token, so get one once with `NJT_USERNAME=... NJT_PASSWORD=... npm run try -- token` and save it as `NJT_TOKEN` too.
- **Your own computer:** `npm start`, then expose it with a tunnel if Claude needs to reach it from the internet.

## Add it to Claude

In Claude: **Settings → Connectors → Add custom connector**, paste your connector URL
(`https://.../mcp/<your MCP_ACCESS_KEY>`), and save. Then ask about trains.

## Settings (environment variables)

| Variable | Needed? | What it does |
| --- | --- | --- |
| `NJT_USERNAME`, `NJT_PASSWORD` | For live data | Your NJ Transit Rail Data API login. Without them: sample data. |
| `NJT_TOKEN` | No | An existing token to start with (saves one of the 5 daily tokens). |
| `MCP_ACCESS_KEY` | Recommended when public | Requires `/mcp/<key>` in the URL (or `Authorization: Bearer <key>`). |
| `NJT_USE_TEST_API` | No | `true` to use NJ Transit's test server. |
| `MOCK_MODE` | No | `true` forces sample data even with credentials. |
| `ALLOWED_ORIGINS` | No | Extra browser origins allowed to call the server, comma-separated. |
| `PORT`, `HOST` | Node only | Where `npm start` listens (default `127.0.0.1:8787`). |

## How it's built

```
src/
  mcp.ts          MCP over Streamable HTTP: initialize, tools/list, tools/call (stateless, JSON responses)
  tools.ts        The tools: schemas, descriptions, and how answers are worded
  njt.ts          NJ Transit RailData client: token handling, caching, retries
  mock.ts         Sample data generated around the current time
  match.ts        Station and line name matching (nicknames, typos)
  time.ts         Eastern-time parsing and formatting
  cache.ts        Memory cache with optional Cloudflare KV behind it
  config.ts       Reads environment variables, picks live or sample data
  worker.ts       Cloudflare Workers entry
  node-server.ts  Node entry (local, Render)
  cli.ts          Run a tool from the terminal
test/             node:test suites; the NJ Transit API is faked, so tests need no account
```

Adding a feature: see [DAILY.md](DAILY.md) and the backlog in [ROADMAP.md](ROADMAP.md).

## Caveats

- The RailData field names and time formats come from the open-source
  [`raildata`](https://github.com/jtarrio/raildata) client, not from NJ Transit's own docs.
  Verify against a real response once you have an account (`npm run try -- next_departures '{"station":"NY"}'`).
- Sample-data station codes are a small plausible set; live data uses NJ Transit's real station list.
- Not affiliated with or endorsed by NJ Transit. Data may not be real time.
