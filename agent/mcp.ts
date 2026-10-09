import { join } from "node:path";

import {
  createMcpExtension,
  type ExtensionAPI,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { step } from "rebuno";

import { CONFIG_DIR } from "./settings.js";

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];
type Listener<K extends "onMessage" | "onError" | "onClose"> = Parameters<
  Transport[K]
>[0];

// pi's own MCP transports, config loader, and credential storage, which its
// package does not export.
const internal = (path: string) =>
  import(
    new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href
  );
const runtime = await internal("./extensions/mcp/runtime.js");
const { loadMcpConfig } = await internal("./extensions/mcp/config.js");
const { InMemoryAuthStorageBackend } = await internal("./core/auth-storage.js");

// What a server offers decides the tools and the prompt, so those requests
// are recorded: a replay gets the same answers without connecting.
const RECORDED = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "resources/templates/list",
]);

// Recorded requests are answered from steps. Everything else, such as tool
// calls, goes to the server, which is connected on first use.
class RecordedTransport implements Transport {
  #live: Promise<Transport> | undefined;
  #handshake: Promise<void> | undefined;
  #initialize: Message | undefined;
  #version: string | undefined;
  #pending = new Map<string | number, (message: Message) => void>();
  #nextId = 0;
  #message = new Set<Listener<"onMessage">>();
  #error = new Set<Listener<"onError">>();
  #close = new Set<Listener<"onClose">>();

  constructor(
    readonly server: string,
    readonly open: () => Promise<Transport>,
  ) {}

  async start() {}

  async send(message: Message) {
    if (
      "method" in message &&
      "id" in message &&
      RECORDED.has(message.method)
    ) {
      const { method, params } = message;
      if (method === "initialize") this.#initialize = message;
      const response = await step("mcp", () => this.#request(message), {
        server: this.server,
        method,
        params: params ?? null,
      });
      for (const listener of this.#message)
        listener({ ...response, id: message.id } as Message);
      return;
    }
    if ("method" in message && !("id" in message) && !this.#live) return;
    await (await this.#ready()).send(message);
  }

  async close() {
    if (this.#live) await (await this.#live).close();
    else for (const listener of this.#close) listener();
  }

  onMessage(listener: Listener<"onMessage">) {
    this.#message.add(listener);
    return () => this.#message.delete(listener);
  }

  onError(listener: Listener<"onError">) {
    this.#error.add(listener);
    return () => this.#error.delete(listener);
  }

  onClose(listener: Listener<"onClose">) {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  setProtocolVersion(version: string) {
    this.#version = version;
    void this.#live?.then((live) => live.setProtocolVersion?.(version));
  }

  #connect() {
    this.#live ??= (async () => {
      const live = await this.open();
      live.onMessage((message) => {
        const resolve =
          "id" in message && !("method" in message)
            ? this.#pending.get(message.id)
            : undefined;
        if (resolve) resolve(message);
        else for (const listener of this.#message) listener(message);
      });
      live.onError((error) => {
        for (const listener of this.#error) listener(error);
      });
      live.onClose(() => {
        for (const listener of this.#close) listener();
      });
      await live.start();
      if (this.#version) live.setProtocolVersion?.(this.#version);
      return live;
    })();
    return this.#live;
  }

  async #request(message: Message & { method: string }): Promise<Message> {
    const live = await this.#connect();
    const id = `rebuno-${this.#nextId++}`;
    const response = new Promise<Message>((resolve) =>
      this.#pending.set(id, resolve),
    );
    await live.send({ ...message, id } as Message);
    try {
      return await response;
    } finally {
      this.#pending.delete(id);
      if (message.method === "initialize")
        this.#handshake ??= Promise.resolve();
    }
  }

  // A connection opened after a replayed initialize repeats the handshake.
  #ready() {
    this.#handshake ??= (async () => {
      if (!this.#initialize) return;
      await this.#request(this.#initialize as Message & { method: string });
      await (await this.#connect()).send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
    })();
    return this.#handshake.then(() => this.#connect());
  }
}

export const mcpCatalog = (): string[] =>
  loadMcpConfig({
    agentDir: CONFIG_DIR,
    cwd: CONFIG_DIR,
    projectTrusted: false,
  }).servers.map((server: { name: string }) => server.name);

const withToken = (value: string, token: string) =>
  value.replace(/\$\{GITHUB_TOKEN\}|\$GITHUB_TOKEN\b/g, token);

// Servers the session does not list load disabled. `${GITHUB_TOKEN}` in a
// header is the dispatch's GitHub token.
export function mcpExtension(githubToken: string, enabled: string[]) {
  const optIn = <T extends { enabled?: boolean; exposure?: string }>(
    name: string,
    config: T,
  ) => ({
    ...config,
    exposure: config.exposure ?? "direct",
    enabled: enabled.includes(name),
  });
  const factory = createMcpExtension({
    createTransport: (entry, cwd, authProvider) =>
      new RecordedTransport(entry.name, async () => {
        const { config } = entry;
        const headers =
          "url" in config && config.headers
            ? Object.fromEntries(
                Object.entries(config.headers).map(([name, value]) => [
                  name,
                  withToken(value, githubToken),
                ]),
              )
            : undefined;
        return runtime.createDefaultTransport(
          headers ? { ...entry, config: { ...config, headers } } : entry,
          cwd,
          authProvider,
        );
      }),
    credentials: new runtime.McpOAuthCredentialStore(
      new InMemoryAuthStorageBackend(),
    ),
    logPath: join(CONFIG_DIR, "mcp.log"),
    loadConfig: (ctx) => {
      const loaded = loadMcpConfig({
        agentDir: CONFIG_DIR,
        cwd: ctx.cwd,
        projectTrusted: false,
      });
      for (const server of loaded.servers)
        server.config = optIn(server.name, server.config);
      return loaded;
    },
  });
  return {
    name: "mcp",
    builtin: true as const,
    replaceable: true,
    // Servers that extensions register skip loadConfig, so they get the same
    // treatment where the MCP extension reads them.
    factory: (pi: ExtensionAPI) =>
      factory(
        new Proxy(pi, {
          get: (target, key) =>
            key === "getMcpServers"
              ? () =>
                  target.getMcpServers().map((server) => ({
                    ...server,
                    config: optIn(server.name, server.config),
                  }))
              : Reflect.get(target, key),
        }),
      ),
  };
}
