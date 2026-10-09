import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";

import { execution } from "rebuno";

import type {
  DriverContext,
  ExecOptions,
  ResourceDriver,
  Workspace,
} from "./types.js";

const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;
const workerEnv = Object.fromEntries(
  Object.entries(env).filter(([name]) => !SECRET.test(name)),
);

const ROOT = resolve(env.WORKSPACE_DIR ?? "workspace");

type Binding = { path: string };

// A git worktree on the worker's disk. Pi sees it at the fixed path `cwd`, as
// it sees a sandbox's checkout, so a fork's worktree builds the same prompt as
// its source's: paths are mapped to the worktree in file access and in
// commands, and back in their output.
class LocalWorkspace implements Workspace {
  readonly local = true;

  constructor(
    readonly cwd: string,
    readonly path: string,
    readonly commandEnv: Record<string, string | undefined>,
  ) {}

  get binding(): Binding {
    return { path: this.path };
  }

  #real(text: string) {
    return text.replace(
      new RegExp(
        `(^|[\\s'"=:(])${escapeRegExp(this.cwd)}(?=/|$|[\\s'";:)])`,
        "g",
      ),
      `$1${this.path}`,
    );
  }

  #shown(text: string) {
    return text.replaceAll(this.path, this.cwd);
  }

  readFile(path: string) {
    return readFile(this.#real(path));
  }

  async writeFile(path: string, content: string) {
    const real = this.#real(path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content);
  }

  exec(command: string, options: ExecOptions = {}) {
    return new Promise<{ exitCode: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn("bash", ["-c", this.#real(command)], {
          cwd: this.#real(options.cwd ?? this.cwd),
          env: this.commandEnv,
          stdio: ["ignore", "pipe", "pipe"],
          signal: options.signal,
          timeout: options.timeoutMs,
          killSignal: "SIGKILL",
        });
        let stdout = "";
        child.stdout.on("data", (data: Buffer) => {
          stdout += data;
          options.onData?.(this.#shown(data.toString()));
        });
        child.stderr.on("data", (data: Buffer) =>
          options.onData?.(this.#shown(data.toString())),
        );
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (signal === "SIGKILL" && !options.signal?.aborted)
            resolve({ exitCode: null, stdout: this.#shown(stdout) });
          else if (options.signal?.aborted) reject(new Error("aborted"));
          else resolve({ exitCode: code ?? 1, stdout: this.#shown(stdout) });
        });
      },
    );
  }

  async pause() {}
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function git(args: string[], gitEnv: Record<string, string>) {
  const child = spawn("git", args, { env: { ...workerEnv, ...gitEnv } });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data;
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0)
    throw new Error(`git ${args.join(" ")}: exit ${code}\n${output.trim()}`);
  return output.trim();
}

// Fetches are serialized per process only; workers sharing a volume
// can collide on git's ref locks.
const clones = new Map<string, Promise<string>>();

// One clone per repository, shared by the worktrees cut from it.
function baseClone(repo: string, gitEnv: Record<string, string>) {
  const base = join(ROOT, "repos", repo.replace("/", "-"));
  const previous = clones.get(base) ?? Promise.resolve("");
  const next = previous
    .catch(() => "")
    .then(async () => {
      if (existsSync(base)) {
        await git(["-C", base, "fetch", "-q", "origin"], gitEnv);
        return base;
      }
      const partial = `${base}.${process.pid}`;
      await mkdir(dirname(base), { recursive: true });
      await rm(partial, { recursive: true, force: true });
      await git(
        [
          "clone",
          "-q",
          "--no-checkout",
          `https://github.com/${repo}.git`,
          partial,
        ],
        gitEnv,
      );
      await git(["-C", partial, "config", "push.default", "current"], gitEnv);
      await rename(partial, base).catch(() =>
        rm(partial, { recursive: true, force: true }),
      );
      return base;
    });
  clones.set(base, next);
  return next;
}

// The token reaches git through the environment, never the disk.
export const workdir = "/workspace/repo";

export default function localDriver({
  repo,
  token,
  cwd,
  identity,
  basicAuth,
  CheckpointUnavailable,
}: DriverContext): ResourceDriver<LocalWorkspace, Binding> {
  const gitEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth(token)}`,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  const workspace = (path: string) =>
    new LocalWorkspace(cwd, path, { ...workerEnv, ...gitEnv });
  return {
    driverId: "uber.local.v1",
    configuration: { repo },
    async create(checkpointRef) {
      const base = await baseClone(repo, gitEnv);
      const path = join(ROOT, "worktrees", execution().id);
      const branch = `rebuno/${execution().id}`;
      if (checkpointRef) {
        await git(
          ["-C", base, "cat-file", "-e", `${checkpointRef}^{commit}`],
          gitEnv,
        ).catch(() => {
          throw new CheckpointUnavailable(
            `checkpoint missing: ${checkpointRef}`,
          );
        });
        await git(
          [
            "-C",
            base,
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            path,
            checkpointRef,
          ],
          gitEnv,
        );
        // The checkpoint commits the uncommitted changes on top of the branch;
        // they are uncommitted again in the new worktree.
        await git(["-C", path, "reset", "-q", `${checkpointRef}^`], gitEnv);
      } else
        await git(
          [
            "-C",
            base,
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            path,
            "origin/HEAD",
          ],
          gitEnv,
        );
      const created = workspace(path);
      return { handle: created, binding: created.binding };
    },
    async open(binding) {
      if (!existsSync(binding.path))
        throw new Error(
          `worktree ${binding.path} is not on this worker's disk; local workspaces need one shared WORKSPACE_DIR`,
        );
      return workspace(binding.path);
    },
    // A commit of the worktree as it is, uncommitted and untracked files
    // included, on top of its branch, kept by a ref of its own.
    async checkpoint(local) {
      const { exitCode, stdout } = await local.exec(
        `index=$(mktemp) && trap 'rm -f "$index"' EXIT` +
          ` && export GIT_INDEX_FILE="$index"` +
          " && git read-tree HEAD && git add -A" +
          ` && commit=$(git commit-tree "$(git write-tree)" -p HEAD -m checkpoint)` +
          ` && git update-ref "refs/rebuno/checkpoints/$commit" "$commit"` +
          ` && echo "$commit"`,
      );
      if (exitCode !== 0)
        throw new Error(`checkpoint failed: exit ${exitCode}`);
      return stdout.trim();
    },
  };
}
