# Feature backlog

One small feature a day. Take the first unchecked item, build it, tick it here,
and log it in CHANGELOG.md. Keep each one to roughly an hour of work: a new
tool, a new option on an existing tool, or a clear improvement to an answer.
Add new ideas at the bottom.

- [x] `last_train` (Nov 18): the last direct train tonight from A to B (uses the full board in `boardWithStops`).
- [x] `plan_trip` with transfers (Nov 19): when there's no one-seat ride, try two-leg trips via Secaucus (SE) or Newark Penn (NP), with the connection time.
- [x] `train_status` crowding by car (Nov 20): use CAPACITY → SECTIONS → CARS to say which end of the train is emptiest.
- [x] `my_commute` (Nov 21): env vars `COMMUTE_HOME` / `COMMUTE_AWAY` (or `COMMUTE_SCHOOL`) (station names); one call shows the next trains both ways.
- [x] `leave_by` (Nov 22): given a train and minutes of walking/driving to the station, say when to leave (Eastern time).
- [x] `next_departures` option `direction` (Nov 23) ("to New York" / "away from New York"), using the DIRECTION field.
- [x] `next_departures` option `njt_only` (Nov 24) to hide Amtrak trains on shared stations.
- [x] `trains_near` (Nov 25): given a latitude/longitude, list trains moving nearby (getVehicleData; sample data needs positions too).
- [x] `elevator_status` (Nov 26): elevator, escalator and accessibility alerts for a station or system-wide.
- [ ] MCP prompt `commute_briefing`: a ready-made prompt that calls service_alerts + my_commute for a morning summary.
- [ ] `list_lines`: every line with its nickname, and which stations it serves (from sample data and live boards).
- [ ] Resource template `njt://station/{code}`: station name, lines, and current alerts as an MCP resource.
- [ ] `delay_report`: how late each line is running right now, from the boards of a few hub stations (NY, SE, NP, TR, HB).
- [ ] `server_status` tool: data mode, cache hits, tokens used today, NJ Transit reachable or not.
- [ ] Hoboken-side sample data: add Main/Bergen, Montclair-Boonton and Raritan Valley lines to `mock.ts`.
- [ ] Holiday and weekend note: flag when NJ Transit runs a weekend/holiday schedule on that day.
- [ ] Skip Amtrak by default in `plan_trip`, `last_train`, `leave_by` and `my_commute` (NJ Transit tickets aren't valid on most Amtrak trains), with an `include_amtrak` option.
