import { createHash, randomUUID } from "node:crypto";

import {
  Daytona,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
} from "@daytonaio/sdk";

import type {
  DriverContext,
  ExecOptions,
  ResourceDriver,
  Workspace,
} from "@rebuno/uber-agent/workspace";

type Binding = { sandboxId: string };

class DaytonaWorkspace implements Workspace {
  readonly local = false;
  paused = false;

  sandbox: Sandbox;
  readonly cwd: string;

  constructor(sandbox: Sandbox, cwd: string) {
    this.sandbox = sandbox;
    this.cwd = cwd;
  }

  get binding(): Binding {
    return { sandboxId: this.sandbox.id };
  }

  async readFile(path: string) {
    return new Uint8Array(await this.sandbox.fs.downloadFile(path));
  }

  async writeFile(path: string, content: string) {
    await this.sandbox.fs.uploadFile(Buffer.from(content), path);
  }

  // Daytona returns a command's output when it ends, so it arrives in one chunk.
  async exec(command: string, options: ExecOptions = {}) {
    try {
      const { exitCode, result } = await this.sandbox.process.executeCommand(
        command,
        options.cwd,
        undefined,
        options.timeoutMs && Math.ceil(options.timeoutMs / 1000),
      );
      options.onData?.(result);
      return { exitCode, stdout: result };
    } catch (error) {
      if (error instanceof DaytonaTimeoutError)
        return { exitCode: null, stdout: "" };
      throw error;
    }
  }

  async pause() {
    await this.sandbox.stop();
    this.paused = true;
  }
}

// The token is a Daytona secret limited to github.com, one per repository,
// updated with each token. The sandbox sees only a placeholder, which Daytona
// replaces on the way out.
export const workdir = "/home/daytona/repo";

export default function daytonaDriver({
  repo,
  token,
  cwd,
  basicAuth,
  prepareCheckout,
  CheckpointUnavailable,
}: DriverContext): ResourceDriver<DaytonaWorkspace, Binding> {
  const daytona = new Daytona();
  const secretName = `rebuno-github-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`;
  const storeToken = async () => {
    const { items } = await daytona.secret.list({ name: secretName });
    const existing = items.find((secret) => secret.name === secretName);
    const value = basicAuth(token);
    if (existing)
      await daytona.secret.update(existing.id, {
        value,
        hosts: ["github.com"],
      });
    else
      await daytona.secret.create({
        name: secretName,
        value,
        hosts: ["github.com"],
      });
  };
  const configureGit = (sandbox: Sandbox) =>
    sandbox.process.executeCommand(
      "git config --global http.https://github.com/.extraheader" +
        ' "Authorization: Basic $GITHUB_AUTH"',
    );
  return {
    driverId: "uber.daytona.v1",
    configuration: { repo },
    async create(checkpointRef) {
      await storeToken();
      let sandbox: Sandbox;
      try {
        sandbox = await daytona.create(
          { snapshot: checkpointRef, secrets: { GITHUB_AUTH: secretName } },
          { timeout: 300 },
        );
      } catch (error) {
        if (checkpointRef && error instanceof DaytonaNotFoundError)
          throw new CheckpointUnavailable(
            `checkpoint missing: ${checkpointRef}`,
          );
        throw error;
      }
      await configureGit(sandbox);
      const workspace = new DaytonaWorkspace(sandbox, cwd);
      await prepareCheckout(workspace, repo, Boolean(checkpointRef));
      return { handle: workspace, binding: workspace.binding };
    },
    async open(binding) {
      await storeToken();
      const sandbox = await daytona.get(binding.sandboxId);
      if (sandbox.state !== "started") await sandbox.start(300);
      await configureGit(sandbox);
      return new DaytonaWorkspace(sandbox, cwd);
    },
    async checkpoint(workspace) {
      if (workspace.paused) await workspace.sandbox.start(300);
      const name = `rebuno-${randomUUID().slice(0, 12)}`;
      try {
        await workspace.sandbox.createSnapshot(name, 600);
        return name;
      } finally {
        if (workspace.paused) await workspace.sandbox.stop();
      }
    },
  };
}
