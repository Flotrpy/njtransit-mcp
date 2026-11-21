# Feature backlog

One small feature a day. Take the first unchecked item, build it, tick it here,
and log it in CHANGELOG.md. Keep each one to roughly an hour of work: a new
tool, a new option on an existing tool, or a clear improvement to an answer.
Add new ideas at the bottom.

- [x] `last_train` (Nov 18): the last direct train tonight from A to B (uses the full board in `boardWithStops`).
- [x] `plan_trip` with transfers (Nov 19): when there's no one-seat ride, try two-leg trips via Secaucus (SE) or Newark Penn (NP), with the connection time.
- [x] `train_status` crowding by car (Nov 20): use CAPACITY → SECTIONS → CARS to say which end of the train is emptiest.
- [x] `my_commute` (Nov 21): env vars `COMMUTE_HOME` / `COMMUTE_AWAY` (or `COMMUTE_SCHOOL`) (station names); one call shows the next trains both ways.
- [ ] `leave_by`: given a train and minutes of walking/driving to the station, say when to leave (Eastern time).
- [ ] `next_departures` option `direction` ("to New York" / "away from New York"), using the DIRECTION field.
- [ ] `next_departures` option `njt_only` to hide Amtrak trains on shared stations.
- [ ] `trains_near`: given a latitude/longitude, list trains moving nearby (getVehicleData; sample data needs positions too).
- [ ] `elevator_status`: filter alerts mentioning elevators or escalators for a station (accessibility).
- [ ] MCP prompt `commute_briefing`: a ready-made prompt that calls service_alerts + my_commute for a morning summary.
- [ ] `list_lines`: every line with its nickname, and which stations it serves (from sample data and live boards).
- [ ] Resource template `njt://station/{code}`: station name, lines, and current alerts as an MCP resource.
- [ ] `delay_report`: how late each line is running right now, from the boards of a few hub stations (NY, SE, NP, TR, HB).
- [ ] `server_status` tool: data mode, cache hits, tokens used today, NJ Transit reachable or not.
- [ ] Hoboken-side sample data: add Main/Bergen, Montclair-Boonton and Raritan Valley lines to `mock.ts`.
- [ ] Holiday and weekend note: flag when NJ Transit runs a weekend/holiday schedule on that day.
