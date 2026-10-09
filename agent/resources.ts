import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { env } from "node:process";

import {
  createSyntheticSourceInfo,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionFactory,
  parseFrontmatter,
  type SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { step } from "rebuno";

import { mcpExtension } from "./mcp.js";
import { CONFIG_DIR } from "./settings.js";

import { quote, type Workspace } from "./workspace/index.js";

const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"];

interface ProjectResources {
  contextFiles: { path: string; content: string }[];
  skills: Pick<
    Skill,
    "name" | "description" | "filePath" | "disableModelInvocation"
  >[];
}

async function lines(workspace: Workspace, script: string) {
  const { stdout } = await workspace.exec(script);
  return stdout.split("\n").filter(Boolean);
}

// pi discovers context files and skills on local disk. They are found in the
// workspace instead, in a step, so that a replay builds the same prompt.
export function loadProjectResources(
  workspace: Workspace,
  cwd: string,
): Promise<ProjectResources> {
  return step("project_resources", async () => {
    const read = (path: string) =>
      workspace
        .readFile(path)
        .then((bytes) => new TextDecoder().decode(bytes).replace(/^﻿/, ""));
    const contextPaths = await lines(
      workspace,
      `d=${quote(cwd)}; while :; do for f in ${CONTEXT_FILES.join(" ")}; do` +
        ` if [ -f "$d/$f" ]; then echo "$d/$f"; break; fi; done;` +
        ` [ "$d" = / ] && break; d=$(dirname "$d"); done`,
    );
    const contextFiles = await Promise.all(
      contextPaths
        .reverse()
        .map(async (path) => ({ path, content: await read(path) })),
    );

    const skillPaths = await lines(
      workspace,
      [".pi/skills", ".agents/skills"]
        .map((dir) => {
          const root = quote(`${cwd}/${dir}`);
          return (
            `if [ -d ${root} ]; then find ${root} -mindepth 1 \\( -name '.*' -o -name node_modules \\) -prune -o` +
            ` -type f \\( -name SKILL.md -o \\( -path ${quote(`${cwd}/${dir}/*.md`)} ! -path ${quote(`${cwd}/${dir}/*/*`)} \\) \\) -print | sort; fi`
          );
        })
        .join("; "),
    ).catch(() => []);
    const skills: ProjectResources["skills"] = [];
    for (const filePath of skillPaths) {
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
        await read(filePath),
      );
      const description =
        typeof frontmatter.description === "string"
          ? frontmatter.description.trim()
          : "";
      if (!description) continue;
      skills.push({
        name:
          typeof frontmatter.name === "string"
            ? frontmatter.name
            : basename(dirname(filePath)),
        description,
        filePath,
        disableModelInvocation:
          frontmatter["disable-model-invocation"] === true,
      });
    }
    return { contextFiles, skills };
  });
}

// Extensions that settings.json turns off, by package name or file name. A
// session can turn them on; the others load for every session.
export async function optionalExtensions(settingsManager: SettingsManager) {
  const { extensions } = await new DefaultPackageManager({
    cwd: CONFIG_DIR,
    agentDir: CONFIG_DIR,
    settingsManager,
  }).resolve();
  const catalog = new Map<string, string[]>();
  for (const { path, enabled, metadata } of extensions) {
    if (enabled) continue;
    const name = metadata.packageRoot
      ? packageName(metadata.packageRoot)
      : basename(path, extname(path)) === "index"
        ? basename(dirname(path))
        : basename(path, extname(path));
    catalog.set(name, [...(catalog.get(name) ?? []), path]);
  }
  return catalog;
}

function packageName(root: string) {
  const manifest = join(root, "package.json");
  const name = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8")).name
    : undefined;
  return typeof name === "string" ? name : basename(root);
}

// pi's prompt points at its own documentation on the worker's disk, which the
// model cannot read in a sandbox, so that section is left out.
const systemPrompt =
  (repo: string): ExtensionFactory =>
  (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt.replace(/<docs>[\s\S]*?<\/docs>\n*/, "").trimEnd()}\nThe repository is ${repo} on GitHub.`,
    }));
  };

export function workspaceResources(options: {
  cwd: string;
  repo: string;
  resources: ProjectResources;
  settingsManager: SettingsManager;
  githubToken: string;
  mcp: string[];
  extensionPaths: string[];
}): DefaultResourceLoader {
  const {
    cwd,
    repo,
    resources,
    settingsManager,
    githubToken,
    mcp,
    extensionPaths,
  } = options;
  const globalContext = CONTEXT_FILES.map((name) => join(CONFIG_DIR, name))
    .filter((path) => existsSync(path))
    .slice(0, 1)
    .map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const workspaceSkills: Skill[] = resources.skills.map((skill) => ({
    ...skill,
    baseDir: dirname(skill.filePath),
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: "workspace",
    }),
  }));
  // pi also reads skills from ~/.agents on the worker, which are left out.
  const homeSkills = join(env.HOME || homedir(), ".agents");
  class WorkspaceResources extends DefaultResourceLoader {
    override getAgentsFiles() {
      return { agentsFiles: [...globalContext, ...resources.contextFiles] };
    }
    override getSkills() {
      const { skills, diagnostics } = super.getSkills();
      return {
        skills: [
          ...skills.filter((skill) => !skill.filePath.startsWith(homeSkills)),
          ...workspaceSkills,
        ],
        diagnostics,
      };
    }
  }
  return new WorkspaceResources({
    cwd,
    agentDir: CONFIG_DIR,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    extensionFactories: [
      { name: "rebuno", factory: systemPrompt(repo), hidden: true },
      mcpExtension(githubToken, mcp),
    ],
    noContextFiles: true,
    noThemes: true,
  });
}
