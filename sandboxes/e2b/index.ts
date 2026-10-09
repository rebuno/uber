import type {
  DriverContext,
  ExecOptions,
  ResourceDriver,
  Workspace,
} from "@rebuno/uber-agent/workspace";
import { CommandExitError, Sandbox, SandboxError, TimeoutError } from "e2b";

const TIMEOUT_MS = 600_000;

type Binding = { sandboxId: string };

class E2BWorkspace implements Workspace {
  readonly local = false;
  paused = false;

  sandbox: Sandbox;
  readonly cwd: string;

  constructor(sandbox: Sandbox, cwd: string) {
    this.sandbox = sandbox;
    this.cwd = cwd;
  }

  get binding(): Binding {
    return { sandboxId: this.sandbox.sandboxId };
  }

  readFile(path: string) {
    return this.sandbox.files.read(path, { format: "bytes" });
  }

  async writeFile(path: string, content: string) {
    await this.sandbox.files.write(path, content);
  }

  async exec(command: string, options: ExecOptions = {}) {
    try {
      const { exitCode, stdout } = await this.sandbox.commands.run(command, {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onStdout: options.onData,
        onStderr: options.onData,
      });
      return { exitCode, stdout };
    } catch (error) {
      if (error instanceof CommandExitError)
        return { exitCode: error.exitCode, stdout: error.stdout };
      if (error instanceof TimeoutError) return { exitCode: null, stdout: "" };
      throw error;
    }
  }

  async pause() {
    await this.sandbox.pause();
    this.paused = true;
  }
}

// The sandbox reaches github.com with the token added by its network rule, so
// the token never enters it.
export const workdir = "/home/user/repo";

export default function e2bDriver({
  repo,
  token,
  cwd,
  basicAuth,
  prepareCheckout,
  CheckpointUnavailable,
}: DriverContext): ResourceDriver<E2BWorkspace, Binding> {
  const configure = async (sandbox: Sandbox) => {
    await sandbox.updateNetwork({
      rules: {
        "github.com": [
          {
            transform: {
              headers: { Authorization: `Basic ${basicAuth(token)}` },
            },
          },
        ],
      },
    });
    return sandbox;
  };
  const connect = async (sandboxId: string) =>
    configure(await Sandbox.connect(sandboxId, { timeoutMs: TIMEOUT_MS }));
  return {
    driverId: "uber.e2b.v1",
    configuration: { repo },
    async create(checkpointRef) {
      let created: Sandbox;
      try {
        created = await Sandbox.create(checkpointRef ?? "base", {
          timeoutMs: TIMEOUT_MS,
          lifecycle: { onTimeout: "pause" },
        });
      } catch (error) {
        if (
          checkpointRef &&
          error instanceof SandboxError &&
          error.statusCode === 404
        )
          throw new CheckpointUnavailable(
            `checkpoint missing: ${checkpointRef}`,
          );
        throw error;
      }
      const workspace = new E2BWorkspace(await configure(created), cwd);
      await prepareCheckout(workspace, repo, Boolean(checkpointRef));
      return { handle: workspace, binding: workspace.binding };
    },
    async open(binding) {
      return new E2BWorkspace(await connect(binding.sandboxId), cwd);
    },
    async checkpoint(workspace) {
      const { sandboxId } = workspace.sandbox;
      if (workspace.paused) workspace.sandbox = await connect(sandboxId);
      try {
        const snapshot = await workspace.sandbox.createSnapshot();
        workspace.sandbox = await connect(sandboxId);
        return snapshot.snapshotId;
      } finally {
        if (workspace.paused) await workspace.sandbox.pause();
      }
    },
  };
}
