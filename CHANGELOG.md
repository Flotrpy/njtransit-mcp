# Changelog

## 0.1.1 (Nov 18, 2026)
- New tool `last_train`: the last direct train tonight between two stations (service day ends 3 AM Eastern), with two earlier backups, skipping cancelled trains, and a note when NJ Transit's board doesn't reach late enough yet.
- `plan_trip` and `last_train` now share one trip finder.

## 0.1.0 (Nov 18, 2026)
- First version: next_departures, plan_trip, train_status, service_alerts, find_station.
- Sample-data mode, NJ Transit RailData client with token caching, Cloudflare Workers and Node entry points.
- 29 tests; checked end to end with the official MCP SDK client on Node and on Cloudflare's local runtime.
