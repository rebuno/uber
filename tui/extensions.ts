import { cwd } from "node:process";

import {
  DefaultResourceLoader,
  getAgentDir,
  type MarkdownTransformer,
  SettingsManager,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";

// pi registers the themes that packages bring through a module its package
// does not export.
const { setRegisteredThemes } = await import(
  new URL(
    "./modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

export interface ClientExtensions {
  // The renderers of calls to a tool: extensions' renderer resolvers in load
  // order, then a tool of that name an extension registers, then `base`.
  renderers(tool: string, base?: ToolRenderers): ToolRenderers;
  markdownTransformers: MarkdownTransformer[];
  settings: SettingsManager;
  commands: Set<string>;
  errors: string[];
}

// Tools run in the agent, so the client takes only what draws: registered
// tools lend their renderers and never run, and hooks never fire.
export async function loadClientExtensions(): Promise<ClientExtensions> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd(), agentDir, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: cwd(),
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  setRegisteredThemes(loader.getThemes().themes);
  const { extensions, errors } = loader.getExtensions();
  const resolvers = extensions.flatMap(
    (extension) => extension.toolRenderers ?? [],
  );
  const tools = new Map(
    extensions.flatMap((extension) =>
      [...extension.tools].map(([name, { definition }]) => [name, definition]),
    ),
  );
  return {
    renderers(tool, base) {
      const resolve = (index: number): ToolRenderers | undefined =>
        index < resolvers.length
          ? resolvers[index](tool, () => resolve(index + 1))
          : (tools.get(tool) ?? base);
      return resolve(0) ?? {};
    },
    markdownTransformers: extensions.flatMap((extension) =>
      extension.markdownTransformer ? [extension.markdownTransformer] : [],
    ),
    settings: settingsManager,
    commands: new Set(
      extensions.flatMap((extension) => [...extension.commands.keys()]),
    ),
    // The agent's built-in extensions are not part of the client.
    errors: errors
      .filter(({ path }) => !path.startsWith("builtin:"))
      .map(({ path, error }) => `extension ${path}: ${error}`),
  };
}
