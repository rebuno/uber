import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, execution, subagent } from "rebuno";
import type { AnyTool } from "./durable.js";
import { AGENT_ID } from "./settings.js";
import type { Workspace } from "./workspace/index.js";

export interface SubagentInput {
  task: string;
  repo: string;
  model?: string;
  thinking?: ThinkingLevel;
  mcp: string[];
  extensions: string[];
  subagent: { binding?: unknown };
}

// The kernel records the subagent's output as the call's result, so it becomes
// a tool result after the step, whether it ran or replayed.
export function subagentTool(
  workspace: Workspace,
  session: Pick<SubagentInput, "repo" | "thinking" | "mcp" | "extensions">,
  model: () => string | undefined,
  onStart: () => void,
  onSuspend: (error: unknown) => void,
): AnyTool {
  const run = defineTool({
    name: "subagent",
    idempotency: "safe_to_retry",
    resources: ["workspace"],
    execute: ({ task }: { task: string }) => {
      onStart();
      const input: SubagentInput = {
        task,
        ...session,
        model: model(),
        subagent: { binding: workspace.binding },
      };
      return subagent(AGENT_ID, input);
    },
  });
  return {
    name: "subagent",
    label: "Subagent",
    promptSnippet: "Delegate a task to a subagent with an isolated context",
    description:
      "Delegate a self-contained task to a subagent with the same tools, working in the same repository, and get its answer back. Give it everything it needs to know; it does not see this conversation.",
    parameters: Type.Object({
      task: Type.String({ description: "What the subagent should do" }),
    }),
    execute: async (_id, params) => {
      try {
        const output = (await run(params as { task: string })) as
          | string
          | { answer?: string }
          | null;
        const text =
          typeof output === "string" ? output : output?.answer || "(no output)";
        return { content: [{ type: "text", text }], details: undefined };
      } catch (error) {
        if (execution().suspension) onSuspend(error);
        throw error;
      }
    },
  };
}
