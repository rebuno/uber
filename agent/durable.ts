import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, rm } from "node:fs/promises";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool, execution, type Idempotency } from "rebuno";

import type { Workspace } from "./workspace/index.js";

// biome-ignore lint/suspicious/noExplicitAny: a tool definition of any schema
export type AnyTool = ToolDefinition<any, any, any>;

const CHANGES_WORKSPACE = new Set(["bash", "edit", "write"]);

type Entry = { customType: string; data: unknown };

// A dispatch replays its recorded tool calls without running them, so the
// extension state they changed is missing from this process. Entries a call
// appends are recorded with its result and appended again on replay, and
// session_start is emitted again before the first call that runs, as on a
// resumed pi session, so extensions rebuild their state from the session.
export class Resume {
  #session?: AgentSession;
  #replayed = false;
  #resumed?: Promise<void>;
  readonly #appended = new AsyncLocalStorage<Entry[]>();

  bind(session: AgentSession) {
    this.#session = session;
    const { sessionManager } = session;
    const append = sessionManager.appendCustomEntry.bind(sessionManager);
    sessionManager.appendCustomEntry = (customType, data) => {
      this.#appended.getStore()?.push({ customType, data });
      return append(customType, data);
    };
  }

  async run<T>(execute: () => Promise<T>) {
    this.#resumed ??= this.#replayed
      ? this.#session?.extensionRunner.emit({
          type: "session_start",
          reason: "resume",
        })
      : Promise.resolve();
    await this.#resumed;
    const entries: Entry[] = [];
    const result = await this.#appended.run(entries, execute);
    return { result, entries };
  }

  replayed(entries: Entry[] = []) {
    this.#replayed = true;
    for (const { customType, data } of entries)
      this.#session?.sessionManager.appendCustomEntry(customType, data);
  }
}

export function durable(
  tool: AnyTool,
  workspace: Workspace,
  onSuspend: (error: unknown) => void,
  resume: Resume,
  idempotency: Idempotency = "safe_to_retry",
): AnyTool {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, ctx) => {
      let ran = false;
      const run = defineTool({
        name: tool.name,
        idempotency,
        resources: CHANGES_WORKSPACE.has(tool.name) ? ["workspace"] : undefined,
        execute: async () => {
          ran = true;
          const { result, entries } = await resume.run(() =>
            execute(id, params, signal, onUpdate, ctx),
          );
          // bash spills long output to a temp file on the worker and names it
          // in the result; moving it into a sandbox keeps that path readable.
          const spill = (
            result.details as { fullOutputPath?: string } | undefined
          )?.fullOutputPath;
          if (spill && !workspace.local) {
            await workspace.writeFile(spill, await readFile(spill, "utf8"));
            await rm(spill);
          }
          return entries.length ? { ...result, entries } : result;
        },
      });
      try {
        const recorded = await run(params as Record<string, unknown>);
        if (typeof recorded === "string") {
          if (!ran) resume.replayed();
          return {
            content: [{ type: "text", text: recorded }],
            details: undefined,
          };
        }
        const { entries, ...result } = recorded as AgentToolResult<unknown> & {
          entries?: Entry[];
        };
        if (!ran) resume.replayed(entries);
        return result;
      } catch (error) {
        if (!ran) resume.replayed();
        if (execution().suspension) onSuspend(error);
        throw error;
      }
    },
  };
}
