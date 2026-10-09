import { createHash } from "node:crypto";
import type {
  DriverContext,
  ExecOptions,
  ResourceDriver,
  Workspace,
} from "@rebuno/uber-agent/workspace";
import {
  ExperimentalOutboundPolicy,
  ModalClient,
  NotFoundError,
  type Sandbox,
} from "modal";

const TIMEOUT_MS = 3_600_000;
// ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_OVERWRITE_IF_EXISTS, which the SDK does not export.
const CREATE_OVERWRITE_IF_EXISTS = 3;

type Binding = { sandboxId: string };

async function forward(
  stream: ReadableStream<string>,
  onData?: (chunk: string) => void,
) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    onData?.(chunk);
  }
  return text;
}

class ModalWorkspace implements Workspace {
  readonly local = false;

  readonly sandbox: Sandbox;
  readonly cwd: string;

  constructor(sandbox: Sandbox, cwd: string) {
    this.sandbox = sandbox;
    this.cwd = cwd;
  }

  get binding(): Binding {
    return { sandboxId: this.sandbox.sandboxId };
  }

  async readFile(path: string) {
    const process = await this.sandbox.exec(["cat", "--", path], {
      mode: "binary",
    });
    const [bytes, stderr] = await Promise.all([
      process.stdout.readBytes(),
      process.stderr.readText(),
    ]);
    if ((await process.wait()) !== 0) throw new Error(stderr.trim());
    return bytes;
  }

  async writeFile(path: string, content: string) {
    const process = await this.sandbox.exec([
      "sh",
      "-c",
      'mkdir -p "$(dirname "$1")" && cat > "$1"',
      "sh",
      path,
    ]);
    await process.stdin.writeText(content);
    await process.stdin.close();
    const stderr = await process.stderr.readText();
    if ((await process.wait()) !== 0) throw new Error(stderr.trim());
  }

  async exec(command: string, options: ExecOptions = {}) {
    const started = Date.now();
    const process = await this.sandbox.exec(["bash", "-c", command], {
      workdir: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    await process.stdin.close();
    const [stdout] = await Promise.all([
      forward(process.stdout, options.onData),
      forward(process.stderr, options.onData),
    ]);
    const exitCode = await process.wait();
    const timedOut =
      options.timeoutMs && Date.now() - started >= options.timeoutMs;
    return { exitCode: timedOut ? null : exitCode, stdout };
  }

  // Modal sandboxes cannot pause; one runs until its timeout.
  async pause() {}
}

// Modal adds the token to requests for github.com outside the sandbox, so the
// token never enters it.
export const workdir = "/workspace/repo";

export default function modalDriver({
  repo,
  token,
  cwd,
  basicAuth,
  prepareCheckout,
  CheckpointUnavailable,
}: DriverContext): ResourceDriver<ModalWorkspace, Binding> {
  const modal = new ModalClient();
  // Outbound policies take only named secrets, which the TypeScript SDK can
  // look up but not create, so the secret is created through Modal's API, one
  // per repository, overwritten with each token.
  const outboundPolicy = async () => {
    const credentials = basicAuth(token);
    const digest = createHash("sha256").update(repo).digest("hex");
    const name = `rebuno-github-${digest.slice(0, 16)}`;
    await modal.cpClient.secretGetOrCreate({
      deploymentName: name,
      environmentName: "",
      objectCreationType: CREATE_OVERWRITE_IF_EXISTS,
      envDict: { GITHUB_BASIC: credentials },
      appId: "",
      requiredKeys: [],
    });
    return new ExperimentalOutboundPolicy().withHeaderReplacement({
      domain: "github.com",
      secret: await modal.secrets.fromName(name),
      headers: { Authorization: "Basic $GITHUB_BASIC" },
    });
  };
  return {
    driverId: "uber.modal.v1",
    configuration: { repo },
    async create(checkpointRef) {
      const app = await modal.apps.fromName("rebuno", {
        createIfMissing: true,
      });
      let sandbox: Sandbox;
      try {
        const image = checkpointRef
          ? await modal.images.fromId(checkpointRef)
          : modal.images
              .fromRegistry("debian:bookworm-slim")
              .dockerfileCommands([
                "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates",
              ]);
        sandbox = await modal.sandboxes.create(app, image, {
          timeoutMs: TIMEOUT_MS,
          experimentalOutboundPolicy: await outboundPolicy(),
        });
      } catch (error) {
        if (checkpointRef && error instanceof NotFoundError)
          throw new CheckpointUnavailable(
            `checkpoint missing: ${checkpointRef}`,
          );
        throw error;
      }
      const workspace = new ModalWorkspace(sandbox, cwd);
      await prepareCheckout(workspace, repo, Boolean(checkpointRef));
      return { handle: workspace, binding: workspace.binding };
    },
    async open(binding) {
      const sandbox = await modal.sandboxes.fromId(binding.sandboxId);
      await sandbox.experimentalUpdateOutboundPolicy(await outboundPolicy());
      return new ModalWorkspace(sandbox, cwd);
    },
    async checkpoint(workspace) {
      return (await workspace.sandbox.snapshotFilesystem()).imageId;
    },
  };
}
