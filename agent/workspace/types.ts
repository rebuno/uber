import {
  type CheckpointUnavailable,
  execution,
  type ResourceDriver,
} from "rebuno";

export type { ResourceDriver } from "rebuno";

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (chunk: string) => void;
}

// A command past its timeout resolves with a null exit code.
export interface Workspace {
  readonly cwd: string;
  readonly local: boolean;
  readonly binding: unknown;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  exec(
    command: string,
    options?: ExecOptions,
  ): Promise<{ exitCode: number | null; stdout: string }>;
  pause(): Promise<void>;
}

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const basicAuth = (token: string) =>
  Buffer.from(`x-access-token:${token}`).toString("base64");

export interface GitIdentity {
  name: string;
  email: string;
}

export async function prepareCheckout(
  workspace: Workspace,
  repo: string,
  restored: boolean,
  identity: GitIdentity,
) {
  const run = async (command: string, options?: ExecOptions) => {
    let output = "";
    const { exitCode } = await workspace.exec(command, {
      ...options,
      onData: (chunk) => {
        output += chunk;
      },
    });
    if (exitCode !== 0)
      throw new Error(`${command}: exit ${exitCode}\n${output.trim()}`);
  };
  if (!restored)
    await run(
      `git clone -q ${quote(`https://github.com/${repo}.git`)} ${quote(workspace.cwd)}`,
      { timeoutMs: 120_000 },
    );
  await run(
    `git branch -m ${quote(`rebuno/${execution().id}`)}` +
      " && (git branch --unset-upstream 2>/dev/null || true)" +
      " && git config push.default current" +
      ` && git config user.name ${quote(identity.name)} && git config user.email ${quote(identity.email)}`,
    { cwd: workspace.cwd },
  );
}

export interface DriverContext {
  repo: string;
  // Valid for an hour, so open() reapplies it; never put it in a binding.
  token: string;
  cwd: string;
  identity: GitIdentity;
  prepareCheckout: (
    workspace: Workspace,
    repo: string,
    restored: boolean,
  ) => Promise<void>;
  basicAuth: typeof basicAuth;
  CheckpointUnavailable: typeof CheckpointUnavailable;
}

// `workdir` must also be readable on the worker, where pi's edit and write
// tools resolve paths.
export interface SandboxModule {
  workdir: string;
  default(context: DriverContext): ResourceDriver<Workspace, unknown>;
}
