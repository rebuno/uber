import { resolve } from "node:path";
import { env } from "node:process";
import { pathToFileURL } from "node:url";

import { CheckpointUnavailable, resource } from "rebuno";

import { SETTINGS } from "../settings.js";
import * as local from "./local.js";
import {
  basicAuth,
  type GitIdentity,
  prepareCheckout,
  type SandboxModule,
  type Workspace,
} from "./types.js";

export type { GitIdentity, Workspace } from "./types.js";
export { quote } from "./types.js";

const sandbox: SandboxModule =
  !env.SANDBOX || env.SANDBOX === "local"
    ? local
    : await import(pathToFileURL(resolve(env.SANDBOX)).href);

// A subagent joins its parent's workspace by binding; the parent alone
// checkpoints it.
export function openWorkspace(
  repo: string,
  token: string,
  identity: GitIdentity,
  join?: unknown,
): Promise<Workspace> {
  const driver = sandbox.default({
    repo,
    token,
    cwd: sandbox.workdir,
    identity,
    prepareCheckout: (workspace, repo, restored) =>
      prepareCheckout(workspace, repo, restored, identity),
    basicAuth,
    CheckpointUnavailable,
  });
  return resource("workspace", {
    driver: join
      ? {
          ...driver,
          create: async () => ({
            handle: await driver.open(join),
            binding: join,
          }),
        }
      : driver,
    checkpoints:
      join || !SETTINGS.checkpointSteps || !driver.checkpoint
        ? undefined
        : { everySteps: SETTINGS.checkpointSteps },
  });
}
