import { resolve } from "node:path";
import { env } from "node:process";

export function requiredEnv(name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// pi's agent directory; the worker's own ~/.pi is never read.
export const CONFIG_DIR = resolve(env.UBER_CONFIG_DIR ?? "config");

export const AGENT_ID = env.UBER_AGENT_ID ?? "uber";

export const SETTINGS = {
  maxRetries: Number(env.LLM_MAX_RETRIES ?? 2),
  checkpointSteps: Number(env.CHECKPOINT_STEPS ?? 0),
};

if (!Number.isInteger(SETTINGS.checkpointSteps) || SETTINGS.checkpointSteps < 0)
  throw new Error(
    "CHECKPOINT_STEPS must be a whole number, 0 to turn checkpoints off",
  );
