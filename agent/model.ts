import { join } from "node:path";

import {
  type Api,
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
import { rebunoFetch } from "rebuno";

import { CONFIG_DIR, SETTINGS } from "./settings.js";

// APIs that send requests through the fetch they are given. Others, such as
// Google's, Bedrock's, and Codex's, would bypass recording and policy.
const RECORDED_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "mistral-conversations",
]);

type Prepare = (
  model: Model<Api>,
  options?: object,
) => Promise<{ model: Model<Api>; options: object }>;

export const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

export async function createModels(
  settings: SettingsManager,
  extensions: LoadExtensionsResult["runtime"],
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
  const runtime = modelRuntime as unknown as { prepareRequest?: Prepare };
  const prepare = runtime.prepareRequest?.bind(modelRuntime);
  if (!prepare)
    throw new Error(
      "pi's ModelRuntime no longer prepares requests in one place",
    );
  // Every request is prepared here, so each model call goes through rebunoFetch.
  runtime.prepareRequest = async (model, options) => {
    if (!RECORDED_APIS.has(model.api))
      throw new Error(
        `${modelKey(model)} uses the ${model.api} API, whose requests cannot be recorded`,
      );
    const prepared = await prepare(model, options);
    return {
      ...prepared,
      options: {
        ...prepared.options,
        fetch: rebunoFetch,
        maxRetries: SETTINGS.maxRetries,
      },
    };
  };

  const available = (await modelRuntime.getAvailable()).filter((model) =>
    RECORDED_APIS.has(model.api),
  );
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
