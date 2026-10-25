import { join } from "node:path";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type LoadExtensionsResult,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Blocked,
  execution,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
  Terminated,
} from "rebuno";

import { CONFIG_DIR, SETTINGS } from "./settings.js";

const REFUSALS = [
  Blocked,
  Terminated,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
];
// Set per run, so a resumed turn would otherwise submit different step args.
const UNRECORDED_FIELDS = new Set([
  "timestamp",
  "durationMs",
  "usage",
  "cost",
  "diagnostics",
  "details",
]);
const DELTA_FLUSH_MS = 50;
const DELTA_MAX_CHARS = 1750;

export const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

const deltaLine = (type: "text" | "thinking", delta: string) =>
  `data: ${JSON.stringify({ type, delta })}\n`;

const failedMessage = (
  model: Model<Api>,
  error: unknown,
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: error instanceof Error ? error.message : String(error),
  timestamp: Date.now(),
});

export async function createModels(
  settings: SettingsManager,
  extensions: LoadExtensionsResult["runtime"],
  onRefusal: (error: unknown) => void,
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(CONFIG_DIR, "models.json"),
    refreshOnCreate: false,
  });
  for (const { name, config } of extensions.pendingProviderRegistrations)
    modelRuntime.registerProvider(name, config);
  for (const { provider } of extensions.pendingNativeProviderRegistrations)
    modelRuntime.registerNativeProvider(provider);
  for (const { definition } of extensions.pendingVirtualModelRegistrations)
    modelRuntime.registerVirtualModel(definition);
  extensions.pendingProviderRegistrations = [];
  extensions.pendingNativeProviderRegistrations = [];
  extensions.pendingVirtualModelRegistrations = [];
  await modelRuntime.refresh({ allowNetwork: false });
  // Every model call, the session's and compaction's, streams through here, so
  // each is a recorded step whatever the provider. A virtual model's call comes
  // back through here with the model it routes to.
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => {
    if (model.api === "pi-virtual")
      return streamSimple(model, context, options);
    const stream = createAssistantMessageEventStream();
    const finish = (message: AssistantMessage) => {
      stream.push(
        message.stopReason === "error" || message.stopReason === "aborted"
          ? { type: "error", reason: message.stopReason, error: message }
          : { type: "done", reason: message.stopReason as "stop", message },
      );
      stream.end();
    };
    void (async () => {
      try {
        const ctx = execution();
        const { stepId, dec } = await ctx.beginLlm(model.id, {
          model: modelKey(model),
          systemPrompt: context.systemPrompt,
          messages: context.messages.map((message) =>
            Object.fromEntries(
              Object.entries(message).filter(
                ([key]) => !UNRECORDED_FIELDS.has(key),
              ),
            ),
          ),
        });
        if (dec.decision === "replay")
          return finish((dec.result as { message: AssistantMessage }).message);
        const live = streamSimple(model, context, {
          ...options,
          maxRetries: SETTINGS.maxRetries,
        });
        let pending = "";
        let seq = 0;
        let flushed = Date.now();
        const flush = async () => {
          for (let i = 0; i < pending.length; i += DELTA_MAX_CHARS)
            await ctx.publishLlmDelta(
              stepId,
              seq++,
              pending.slice(i, i + DELTA_MAX_CHARS),
            );
          pending = "";
          flushed = Date.now();
        };
        for await (const event of live) {
          if (event.type === "done" || event.type === "error") continue;
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            pending += deltaLine(
              event.type === "text_delta" ? "text" : "thinking",
              event.delta,
            );
            if (Date.now() - flushed >= DELTA_FLUSH_MS) await flush();
          }
          stream.push(event);
        }
        await flush();
        const message = await live.result();
        if (message.stopReason === "error" || message.stopReason === "aborted")
          await ctx.failStepQuietly(
            stepId,
            message.errorMessage ?? message.stopReason,
          );
        else
          await ctx.recordLlm(stepId, {
            message,
            usage: {
              input_tokens: message.usage.input,
              output_tokens: message.usage.output,
            },
          });
        finish(message);
      } catch (error) {
        if (REFUSALS.some((refusal) => error instanceof refusal))
          onRefusal(error);
        finish(failedMessage(model, error));
      }
    })();
    return stream;
  };

  const available = await modelRuntime.getAvailable();
  const usable = new Set(available.map(modelKey));
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  const configured = available.find(
    (model) => model.provider === provider && model.id === id,
  );
  const enabled = settings.getEnabledModels();
  const scoped = enabled?.length
    ? (
        await resolveModelScopeWithDiagnostics(enabled, modelRuntime)
      ).scopedModels
        .map(({ model }) => model)
        .filter((model) => usable.has(modelKey(model)))
    : available;
  const models = [
    ...(configured ? [configured] : []),
    ...scoped.filter(
      (model) => !configured || modelKey(model) !== modelKey(configured),
    ),
  ];
  if (!models.length)
    throw new Error(
      "no models: set a provider's API key, or add a provider to models.json in the config directory",
    );
  // `provider/id`, or an ID that one model has.
  const find = (reference: string | undefined) => {
    const exact = models.find((model) => modelKey(model) === reference);
    const byId = models.filter((model) => model.id === reference);
    return exact ?? (byId.length === 1 ? byId[0] : undefined);
  };
  return { modelRuntime, models, find };
}
