import { env } from "node:process";
import { Writable } from "node:stream";
import type {
  DriverContext,
  ExecOptions,
  ResourceDriver,
  Workspace,
} from "@rebuno/uber-agent/workspace";
import { APIError, type NetworkPolicy, Sandbox } from "@vercel/sandbox";

const TIMEOUT_MS = 600_000;

type Binding = { name: string };

// An access token when VERCEL_TOKEN is set; otherwise the SDK uses
// VERCEL_OIDC_TOKEN.
const credentials = env.VERCEL_TOKEN
  ? {
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID ?? "",
      projectId: env.VERCEL_PROJECT_ID ?? "",
    }
  : {};

const sink = (onData?: (chunk: string) => void) =>
  new Writable({
    write(chunk, _encoding, done) {
      onData?.(chunk.toString());
      done();
    },
  });

class VercelWorkspace implements Workspace {
  readonly local = false;
  paused = false;

  sandbox: Sandbox;
  readonly cwd: string;

  constructor(sandbox: Sandbox, cwd: string) {
    this.sandbox = sandbox;
    this.cwd = cwd;
  }

  get binding(): Binding {
    return { name: this.sandbox.name };
  }

  async readFile(path: string) {
    const buffer = await this.sandbox.readFileToBuffer({ path });
    if (!buffer) throw new Error(`ENOENT: ${path}`);
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: string) {
    await this.sandbox.writeFiles([{ path, content }]);
  }

  async exec(command: string, options: ExecOptions = {}) {
    const started = Date.now();
    const finished = await this.sandbox.runCommand({
      cmd: "bash",
      args: ["-c", command],
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      stdout: sink(options.onData),
      stderr: sink(options.onData),
    });
    const timedOut =
      options.timeoutMs && Date.now() - started >= options.timeoutMs;
    return {
      exitCode: timedOut ? null : finished.exitCode,
      stdout: await finished.stdout(),
    };
  }

  async pause() {
    await this.sandbox.stop();
    this.paused = true;
  }
}

// The network policy adds the token to requests for github.com outside the
// sandbox, so the token never enters it.
export const workdir = "/vercel/sandbox/repo";

export default function vercelDriver({
  repo,
  token,
  cwd,
  basicAuth,
  prepareCheckout,
  CheckpointUnavailable,
}: DriverContext): ResourceDriver<VercelWorkspace, Binding> {
  const networkPolicy: NetworkPolicy = {
    allow: {
      "*": [],
      "github.com": [
        {
          transform: [
            { headers: { Authorization: `Basic ${basicAuth(token)}` } },
          ],
        },
      ],
    },
  };
  const resume = (name: string) =>
    Sandbox.get({ name, resume: true, ...credentials });
  return {
    driverId: "uber.vercel.v1",
    configuration: { repo },
    async create(checkpointRef) {
      let sandbox: Sandbox;
      try {
        const params = { timeout: TIMEOUT_MS, networkPolicy, ...credentials };
        sandbox = await (checkpointRef
          ? Sandbox.create({
              ...params,
              source: { type: "snapshot", snapshotId: checkpointRef },
            })
          : Sandbox.create(params));
      } catch (error) {
        if (
          checkpointRef &&
          error instanceof APIError &&
          error.response.status === 404
        )
          throw new CheckpointUnavailable(
            `checkpoint missing: ${checkpointRef}`,
          );
        throw error;
      }
      const workspace = new VercelWorkspace(sandbox, cwd);
      await prepareCheckout(workspace, repo, Boolean(checkpointRef));
      return { handle: workspace, binding: workspace.binding };
    },
    async open(binding) {
      const sandbox = await resume(binding.name);
      await sandbox.updateNetworkPolicy(networkPolicy);
      return new VercelWorkspace(sandbox, cwd);
    },
    async checkpoint(workspace) {
      const { name } = workspace.sandbox;
      if (workspace.paused) workspace.sandbox = await resume(name);
      try {
        const snapshot = await workspace.sandbox.snapshot();
        workspace.sandbox = await resume(name);
        return snapshot.snapshotId;
      } finally {
        if (workspace.paused) await workspace.sandbox.stop();
      }
    },
  };
}
