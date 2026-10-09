import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface Preferences {
  models?: string[];
  mcpServers?: Record<string, { enabled?: boolean }>;
  extensions?: Record<string, { enabled?: boolean }>;
}

export type Optional = "mcpServers" | "extensions";

export const PREFERENCES = join(getAgentDir(), "uber.json");

const read = (): Preferences =>
  existsSync(PREFERENCES) ? JSON.parse(readFileSync(PREFERENCES, "utf8")) : {};

export const models = () => read().models ?? [];

// The agent's MCP servers or optional extensions listed in uber.json, on
// unless `enabled` is false.
export const listed = (kind: Optional) =>
  Object.entries(read()[kind] ?? {}).map(([name, entry]) => ({
    name,
    enabled: entry.enabled !== false,
  }));

export function setEnabled(kind: Optional, name: string, enabled: boolean) {
  const preferences = read();
  preferences[kind] = {
    ...preferences[kind],
    [name]: { ...preferences[kind]?.[name], enabled },
  };
  mkdirSync(dirname(PREFERENCES), { recursive: true });
  writeFileSync(PREFERENCES, `${JSON.stringify(preferences, null, 2)}\n`);
}

// Undefined while uber.json lists none, so sessions keep their own list.
export function enabled(kind: Optional) {
  const entries = listed(kind);
  return entries.length
    ? entries.filter((entry) => entry.enabled).map(({ name }) => name)
    : undefined;
}
