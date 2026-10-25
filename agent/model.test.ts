import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const config = mkdtempSync(join(tmpdir(), "uber-models-"));
const model = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8000,
});
writeFileSync(
  join(config, "models.json"),
  JSON.stringify({
    providers: {
      gateway: {
        baseUrl: "http://localhost:9/v1",
        api: "openai-completions",
        apiKey: "test",
        models: [model("coder")],
      },
      gemini: {
        baseUrl: "http://localhost:9",
        api: "google-generative-ai",
        apiKey: "test",
        models: [model("flash")],
      },
    },
  }),
);
mkdirSync(join(config, "extensions"));
env.UBER_CONFIG_DIR = config;
const { createModels } = await import("./model.js");

async function load() {
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: config,
    agentDir: config,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
  });
  await loader.reload();
  return createModels(settings, loader.getExtensions().runtime, () => {});
}

test("every provider's model calls are recorded steps", async () => {
  const { modelRuntime, find } = await load();
  const flash = find("gemini/flash");
  assert.ok(flash);
  const message = await modelRuntime
    .streamSimple(flash, { messages: [] })
    .result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /execution/i);
});
