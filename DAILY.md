# Daily feature routine

Instructions for the run that adds one small feature each day.

Code: `/mnt/project-files/connectors/njtransit-mcp/` (this folder). Node 22.18+ runs the TypeScript directly.

1. Read `ROADMAP.md` and `CHANGELOG.md`. Pick the first unchecked item. If it's bigger than about an hour, build the smallest useful slice and add the rest back as a new item.
2. Build it:
   - A new tool goes in `src/tools.ts`: add a `ToolDef` (clear `description`, JSON `inputSchema`, `annotations: READ_ONLY`) and add it to `TOOLS`.
   - New NJ Transit calls go in `src/njt.ts` (cache every call; never add calls to `getToken` or `getStationSchedule`, which have tiny daily limits) and must also be added to the `RailSource` interface in `src/types.ts` and to `src/mock.ts` so sample mode keeps working.
   - All times shown to people go through `src/time.ts` (Eastern).
   - Every answer ends with `footer(...)` so sample data stays labelled.
3. Test:
   - Add tests in `test/` (sample data in `mcp.test.ts`, fake NJ Transit responses in `njt.test.ts`).
   - `npm test` must pass. Then `npm install` once and `npm run typecheck`.
   - Try it by hand: `npm run try -- <tool> '<json args>'`.
   - If `tools/list` changed, update the test that lists tool names and the Tools table in `README.md`.
4. Record it: tick the item in `ROADMAP.md`, add a dated line to `CHANGELOG.md`, bump the patch version in `package.json` and `SERVER_VERSION` in `src/mcp.ts`.
5. Do NOT deploy, push, or change any hosting settings unless Affan has said yes to that. Report one line: what was added and an example question it answers.
