#!/usr/bin/env node
import { env } from "node:process";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Agent, execution, previous, Result, raiseForRefusal } from "rebuno";

import { durable, Resume } from "./durable.js";
import { githubToken, gitIdentity } from "./github.js";
import { mcpCatalog } from "./mcp.js";
import { createModels, modelKey } from "./model.js";
import {
  loadProjectResources,
  optionalExtensions,
  workspaceResources,
} from "./resources.js";
import { AGENT_ID, CONFIG_DIR, requiredEnv } from "./settings.js";
import { subagentTool } from "./subagents.js";
import { codingTools } from "./tools.js";
import { openWorkspace } from "./workspace/index.js";

const Input = Type.Object({
  task: Type.String({ description: "What to do" }),
  repo: Type.Optional(
    Type.String({
      pattern: "^[\\w.-]+/[\\w.-]+$",
      description: "GitHub repository as owner/name",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model as provider/id" })),
  thinking: Type.Optional(
    Type.Union(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) =>
        Type.Literal(level),
      ),
    ),
  ),
  mcp: Type.Optional(
    Type.Array(Type.String(), { description: "MCP servers to turn on" }),
  ),
  extensions: Type.Optional(
    Type.Array(Type.String(), { description: "Extensions to turn on" }),
  ),
  subagent: Type.Optional(
    Type.Object({ binding: Type.Optional(Type.Unknown()) }),
  ),
});

const Output = Type.Object({ answer: Type.Optional(Type.String()) });

async function process(input: Static<typeof Input>) {
  const isSubagent = input.subagent !== undefined;
  const state = await previous<{
    entries: never[];
    repo?: string;
    model?: string;
    thinking?: ThinkingLevel;
    mcp?: string[];
    extensions?: string[];
  }>();
  const prior = state?.entries;
  const repo = state?.repo ?? input.repo ?? env.REPO;
  if (!repo)
    throw new Error(
      "no repository: start the session from a clone of a GitHub repository, or set REPO",
    );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`repository must be owner/name, got ${repo}`);
  if (input.repo && input.repo !== repo)
    throw new Error(`session works on ${repo}, not ${input.repo}`);
  const mcp = input.mcp ?? state?.mcp ?? [];
  const extensions = input.extensions ?? state?.extensions ?? [];
  const thinking =
    (input.thinking as ThinkingLevel | undefined) ?? state?.thinking;
  const token = await githubToken(repo);
  const workspace = await openWorkspace(
    repo,
    token,
    await gitIdentity(token),
    input.subagent?.binding,
  );
  const resources = await loadProjectResources(workspace, workspace.cwd);

  // pi hands a tool's error to the model and keeps going. A call that suspends
  // the execution, held for approval or waiting on subagents, aborts the run
  // instead, so no further model calls are refused.
  let suspended: unknown;
  const onSuspend = (error: unknown) => {
    suspended ??= error;
    void session.abort();
  };
  const resume = new Resume();
  let delegated = false;
  const customTools = [
    ...codingTools(workspace).map((tool) =>
      durable(tool, workspace, onSuspend, resume),
    ),
    ...(isSubagent
      ? []
      : [
          subagentTool(
            workspace,
            { repo, thinking, mcp, extensions },
            () => session.model && modelKey(session.model),
            () => {
              delegated = true;
            },
            onSuspend,
          ),
        ]),
  ];

  // Settings in the repository being worked on are never read.
  const settingsManager = SettingsManager.create(workspace.cwd, CONFIG_DIR, {
    projectTrusted: false,
  });
  const optional = await optionalExtensions(settingsManager);
  const unavailable = extensions.filter((name) => !optional.has(name));
  if (unavailable.length)
    throw new Error(
      `extension ${unavailable.join(", ")} is not one the agent offers, which are ${[...optional.keys()].join(", ") || "none"}`,
    );
  const resourceLoader = workspaceResources({
    cwd: workspace.cwd,
    repo,
    resources,
    settingsManager,
    githubToken: token,
    mcp,
    extensionPaths: extensions.flatMap((name) => optional.get(name) ?? []),
  });
  await resourceLoader.reload();
  const { models, modelRuntime, find } = await createModels(
    settingsManager,
    resourceLoader.getExtensions().runtime,
  );
  const requested = find(input.model);
  if (input.model && !requested)
    throw new Error(
      `model ${input.model} is not one model of ${models.map(modelKey).join(", ")}`,
    );
  const catalog = [
    ...mcpCatalog(),
    ...resourceLoader
      .getExtensions()
      .runtime.mcpServers.list()
      .map(({ name }) => name),
  ];
  const unknown = mcp.filter((server) => !catalog.includes(server));
  if (unknown.length)
    throw new Error(
      `MCP server ${unknown.join(", ")} is not one of the agent's, which are ${catalog.join(", ") || "none"}`,
    );
  // pi retries a failed turn by itself; the provider's retries cover that, so
  // each model call keeps one step. Overrides last until settings reload.
  settingsManager.applyOverrides({ retry: { enabled: false } });
  // MCP tools register once their server connects, so registration is wrapped.
  // A tool not marked read-only may have changed something, so an interrupted
  // call is not repeated.
  for (const extension of resourceLoader.getExtensions().extensions) {
    const set = extension.tools.set.bind(extension.tools);
    extension.tools.set = (name, registered) =>
      set(name, {
        ...registered,
        definition: durable(
          registered.definition,
          workspace,
          onSuspend,
          resume,
          registered.definition.annotations?.readOnlyHint
            ? "safe_to_retry"
            : "at_most_once",
        ),
      });
    for (const [name, registered] of extension.tools)
      extension.tools.set(name, registered);
  }

  const { session } = await createAgentSession({
    cwd: workspace.cwd,
    agentDir: CONFIG_DIR,
    modelRuntime,
    model: find(state?.model) ?? requested ?? models[0],
    noTools: "builtin",
    customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(workspace.cwd, undefined, prior),
    settingsManager,
  });
  resume.bind(session);
  await session.bindExtensions({ mode: "print" });
  if (
    requested &&
    (!session.model || modelKey(requested) !== modelKey(session.model))
  )
    await session.setModel(requested);
  if (thinking) session.setThinkingLevel(thinking);

  let finished = false;
  try {
    await session.prompt(input.task);
    if (suspended) throw suspended;
    // A failed model call ends the run with an error message rather than throwing.
    const { errorMessage } = session.state;
    if (errorMessage) {
      raiseForRefusal(new Error(errorMessage));
      throw new Error(errorMessage);
    }
    finished = true;
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    // The parent owns the workspace. It stays running while subagents use it.
    const idle = finished || (execution().suspension && !delegated);
    if (!isSubagent && idle) await workspace.pause();
  }

  const last = session.messages.at(-1);
  const answer =
    last?.role === "assistant"
      ? last.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("")
      : undefined;
  return new Result({
    output: { answer },
    state: {
      entries: session.sessionManager.getEntries(),
      repo,
      model: session.model && modelKey(session.model),
      thinking,
      mcp,
      extensions,
    },
  });
}

const agent = new Agent(AGENT_ID, {
  description:
    "Coding agent that works on a GitHub repository and answers with its result",
  inputSchema: Input,
  outputSchema: Output,
  secret: requiredEnv("REBUNO_AGENT_SECRET"),
  baseUrl: env.REBUNO_URL ?? "http://localhost:8080",
});
await agent.serve({ port: Number(env.PORT ?? 5000) }, process);
