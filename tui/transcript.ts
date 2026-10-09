import { cwd } from "node:process";
import {
  AssistantMessageComponent,
  CompactionSummaryMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  TruncatedText,
  type TUI,
} from "@earendil-works/pi-tui";

import type { Step } from "rebuno";

import type { ClientExtensions } from "./extensions.js";
import { errorText } from "./kernel.js";
import { assistantMessage, messageText } from "./messages.js";
import { theme } from "./ui.js";

// The tool definitions are used only for their renderers. A tool without
// renderers from these or from client extensions gets empty ones, which pi
// draws with its collapsed generic view; without any, pi treats the tool as
// unknown and prints its arguments and result in full.
const RENDERERS: Record<
  string,
  ConstructorParameters<typeof ToolExecutionComponent>[4]
> = {
  read: createReadToolDefinition(cwd()),
  edit: createEditToolDefinition(cwd()),
  write: createWriteToolDefinition(cwd()),
  bash: createBashToolDefinition(cwd()),
};

export class Transcript extends Container {
  readonly #tools = new Map<string, ToolExecutionComponent>();
  readonly #unfinished = new Set<string>();
  readonly #messages = new Map<string, AssistantMessageComponent>();
  readonly #streams = new Map<string, string>();
  readonly #summaries = new Set<string>();
  readonly #compactions: CompactionSummaryMessageComponent[] = [];
  #contextTokens = 0;
  #expanded = false;
  readonly usage = { input: 0, output: 0 };

  constructor(
    private readonly ui: TUI,
    private readonly extensions: ClientExtensions,
  ) {
    super();
  }

  get contextTokens() {
    return this.#contextTokens;
  }

  reset() {
    this.finish("closed");
    this.clear();
    for (const collection of [
      this.#tools,
      this.#unfinished,
      this.#messages,
      this.#streams,
      this.#summaries,
    ]) {
      collection.clear();
    }
    this.#compactions.length = 0;
    this.#contextTokens = 0;
    this.usage.input = 0;
    this.usage.output = 0;
  }

  user(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new UserMessageComponent(text));
  }

  notice(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new TruncatedText(theme().fg("error", text), 1, 0));
  }

  info(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new Text(text, 1, 0));
  }

  toggleExpanded() {
    this.#expanded = !this.#expanded;
    for (const card of [...this.#tools.values(), ...this.#compactions])
      card.setExpanded(this.#expanded);
  }

  modelStarted(stepId: string, summarizing: boolean) {
    if (summarizing) this.#summaries.add(stepId);
    else this.#message(stepId);
  }

  modelDelta(stepId: string, data: string) {
    if (this.#summaries.has(stepId)) return;
    const body = (this.#streams.get(stepId) ?? "") + data;
    this.#streams.set(stepId, body);
    this.#message(stepId).updateContent(assistantMessage(body), true);
  }

  modelFinished(stepId: string, body: string) {
    const message = assistantMessage(body);
    if (!this.#summaries.has(stepId)) {
      this.#message(stepId).updateContent(message, false);
      return;
    }
    const streamed = this.#messages.get(stepId);
    if (streamed) this.removeChild(streamed);
    const card = new CompactionSummaryMessageComponent({
      role: "compactionSummary",
      summary: messageText(message),
      tokensBefore: this.#contextTokens,
      timestamp: Date.now(),
    });
    card.setExpanded(this.#expanded);
    this.#compactions.push(card);
    this.addChild(new Spacer(1));
    this.addChild(card);
  }

  // The newest answer's usage is the context size a later summary replaces.
  modelUsage(
    stepId: string,
    usage: { input_tokens?: number; output_tokens?: number },
  ) {
    this.usage.input += usage.input_tokens ?? 0;
    this.usage.output += usage.output_tokens ?? 0;
    if (!this.#summaries.has(stepId))
      this.#contextTokens =
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }

  toolProposed(stepId: string, name: string, args: unknown) {
    const card = new ToolExecutionComponent(
      name,
      stepId,
      args ?? {},
      {},
      this.extensions.renderers(name, RENDERERS[name]),
      this.ui,
      cwd(),
    );
    card.setArgsComplete();
    card.setExpanded(this.#expanded);
    this.#tools.set(stepId, card);
    this.#unfinished.add(stepId);
    this.addChild(card);
  }

  toolStarted(stepId: string) {
    this.#tools.get(stepId)?.markExecutionStarted();
  }

  toolFinished(step: Step) {
    const card = this.#tools.get(step.stepId);
    if (!card) return;
    this.#unfinished.delete(step.stepId);
    if (step.status !== "succeeded") {
      card.updateResult(
        {
          content: [{ type: "text", text: errorText(step.error) }],
          isError: true,
        },
        false,
      );
    } else if (typeof step.result === "string") {
      card.updateResult(
        { content: [{ type: "text", text: step.result }], isError: false },
        false,
      );
    } else {
      const result = step.result as {
        content: { type: string; text?: string }[];
        details?: unknown;
        isError?: boolean;
      };
      card.updateResult({ ...result, isError: result.isError ?? false }, false);
    }
  }

  finish(status: string) {
    for (const stepId of this.#unfinished) {
      const text = `Not finished: the execution was ${status}.`;
      this.#tools
        .get(stepId)
        ?.updateResult(
          { content: [{ type: "text", text }], isError: true },
          false,
        );
    }
    this.#unfinished.clear();
  }

  #message(stepId: string) {
    let component = this.#messages.get(stepId);
    if (!component) {
      component = new AssistantMessageComponent(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        this.extensions.markdownTransformers,
      );
      this.#messages.set(stepId, component);
      this.addChild(component);
    }
    return component;
  }
}
