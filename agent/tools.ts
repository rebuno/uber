import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AnyTool } from "./durable.js";
import { quote, type Workspace } from "./workspace/index.js";

// The worker's environment holds its credentials, so commands never get it.
export function codingTools(workspace: Workspace): AnyTool[] {
  const exists = async (path: string) =>
    (await workspace.exec(`test -e ${quote(path)}`)).exitCode === 0;
  const files = {
    readFile: async (path: string) =>
      Buffer.from(await workspace.readFile(path)),
    access: async (path: string) => {
      if (!(await exists(path))) throw new Error(`${path} does not exist`);
    },
    writeFile: (path: string, content: string) =>
      workspace.writeFile(path, content),
    mkdir: async (dir: string) => {
      await workspace.exec(`mkdir -p ${quote(dir)}`);
    },
  };
  const bash: BashOperations = {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const timeoutSeconds = timeout ?? 600;
      const result = await workspace
        .exec(command, {
          cwd,
          signal,
          timeoutMs: timeoutSeconds * 1000,
          onData: (data) => onData(Buffer.from(data)),
        })
        .catch((error) => {
          throw signal?.aborted ? new Error("aborted") : error;
        });
      if (result.exitCode === null)
        throw new Error(`timeout:${timeoutSeconds}`);
      return result;
    },
  };
  const { cwd } = workspace;
  return [
    createReadToolDefinition(cwd, { operations: files }),
    createBashToolDefinition(cwd, {
      operations: bash,
      exposeSessionEnvironment: false,
    }),
    createEditToolDefinition(cwd, { operations: files }),
    createWriteToolDefinition(cwd, { operations: files }),
  ];
}
