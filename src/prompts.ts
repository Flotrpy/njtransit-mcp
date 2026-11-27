/** MCP prompts: ready-made requests a user can pick in their client. */

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  build(args: Record<string, string>): string;
}

const commuteBriefing: PromptDef = {
  name: "commute_briefing",
  title: "Commute briefing",
  description: "A short summary of your next trains and any alerts that affect them, for the start or end of the day.",
  arguments: [
    { name: "home", description: "Home station (optional if COMMUTE_HOME is set on the server)." },
    { name: "away", description: "School or work station (optional if COMMUTE_AWAY is set on the server)." },
  ],
  build(args) {
    const home = args.home?.trim();
    const away = args.away?.trim();
    const commuteArgs = [home && `home "${home}"`, away && `away "${away}"`].filter(Boolean).join(" and ");
    return [
      "Give me a short NJ Transit commute briefing.",
      `1. Call my_commute${commuteArgs ? ` with ${commuteArgs}` : ""} to get my next trains.`,
      "2. Call service_alerts for each station in those trips, and keep only alerts that affect my lines or stations.",
      "3. Reply in a few lines: the next train I should take with its time and any delay, one backup train, and any alert that matters. Say plainly if everything looks normal.",
      "Use Eastern time. If the data is sample data, say so in one line.",
    ].join("\n");
  },
};

export const PROMPTS: PromptDef[] = [commuteBriefing];
