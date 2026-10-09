import { execFileSync } from "node:child_process";
import { cwd, env } from "node:process";

import { Client, type Execution } from "rebuno";

export const AGENT = env.UBER_AGENT_ID ?? "uber";
export const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export const LOCAL_REPO = (() => {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
  } catch {
    return undefined;
  }
})();

const BASE_URL = (env.REBUNO_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HEADERS: Record<string, string> = env.REBUNO_API_KEY
  ? { Authorization: `Bearer ${env.REBUNO_API_KEY}` }
  : {};

export const client = new Client({ baseUrl: BASE_URL });

export const DASHBOARD_URL = (
  env.REBUNO_DASHBOARD_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

interface ExecutionSummary {
  id: string;
  session?: string;
  status: string;
  input?: { task?: string };
  created_at: string;
}

async function listExecutions(
  filter: Record<string, string>,
): Promise<ExecutionSummary[]> {
  const query = new URLSearchParams({
    agent_id: AGENT,
    limit: "100",
    ...filter,
  });
  const response = await fetch(`${BASE_URL}/v0/executions?${query}`, {
    headers: HEADERS,
  });
  if (!response.ok)
    throw new Error(`listing executions: HTTP ${response.status}`);
  return (
    ((await response.json()) as { executions: ExecutionSummary[] | null })
      .executions ?? []
  );
}

export async function sessionExecutions(session: string): Promise<Execution[]> {
  const executions = await listExecutions({ session });
  return Promise.all(executions.reverse().map(({ id }) => client.get(id)));
}

export async function recentSessions() {
  const latest = new Map<string, ExecutionSummary>();
  for (const execution of await listExecutions({})) {
    if (execution.session && !latest.has(execution.session))
      latest.set(execution.session, execution);
  }
  return [...latest.entries()].map(([session, execution]) => ({
    session,
    execution,
  }));
}

// Live deltas are raw chunks of the provider's event stream; frames arrive
// whole, while the chunks inside them can split a provider line.
export async function streamDeltas(
  executionId: string,
  onDelta: (stepId: string, data: string) => void,
  signal: AbortSignal,
) {
  try {
    const response = await fetch(
      `${BASE_URL}/v0/executions/${executionId}/stream`,
      { headers: HEADERS, signal },
    );
    if (!response.body) return;
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const delta = JSON.parse(line.slice(6)) as {
          step_id: string;
          data: string;
        };
        onDelta(delta.step_id, delta.data);
      }
    }
  } catch {
    // The stream is best-effort; recorded step results replace whatever it showed.
  }
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return (
    (error as { message?: string } | null)?.message ?? JSON.stringify(error)
  );
}
