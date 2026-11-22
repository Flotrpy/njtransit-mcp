# Changelog

## 0.1.5 (Nov 22, 2026)
- New tool `leave_by`: what time to leave to catch a train, from minutes to the station plus a few spare minutes (default 3). Give a train number, or a destination to get the next direct train you can still make and a backup. Uses expected times, so delays move the leave time, and says plainly when it's too late.

## 0.1.4 (Nov 21, 2026)
- New tool `my_commute`: the next trains both ways between a saved home station and a saved destination (`COMMUTE_HOME`, `COMMUTE_AWAY`; `COMMUTE_SCHOOL` or `COMMUTE_WORK` also work), or any two stations passed in. The trip away from home comes first in the morning and the trip home first after noon. Uses one-change trips when no direct train runs.
- `plan_trip` and `my_commute` share one planner.

## 0.1.3 (Nov 20, 2026)
- `train_status` now says which end of the train is emptiest (front, middle or back), the two emptiest cars counted from the front, and which cars have restrooms, when NJ Transit reports per-car counts. Sample trains have 8 cars with made-up counts.

## 0.1.2 (Nov 19, 2026)
- `plan_trip` now plans trips with one change when no train goes all the way: it tries Secaucus (SE) and Newark Penn (NP), allows at least 5 and 4 minutes to change, skips cancelled trains and waits over an hour, and shows the soonest arrivals first with the connection time.

## 0.1.1 (Nov 18, 2026)
- New tool `last_train`: the last direct train tonight between two stations (service day ends 3 AM Eastern), with two earlier backups, skipping cancelled trains, and a note when NJ Transit's board doesn't reach late enough yet.
- `plan_trip` and `last_train` now share one trip finder.

## 0.1.0 (Nov 18, 2026)
- First version: next_departures, plan_trip, train_status, service_alerts, find_station.
- Sample-data mode, NJ Transit RailData client with token caching, Cloudflare Workers and Node entry points.
- 29 tests; checked end to end with the official MCP SDK client on Node and on Cloudflare's local runtime.
