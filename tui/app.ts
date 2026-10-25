import { userInfo } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  ExtensionSelectorComponent,
  keyHint,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  getKeybindings,
  hyperlink,
  ProcessTerminal,
  ScrollView,
  type SlashCommand,
  Spacer,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Execution } from "rebuno";
import type { ClientExtensions } from "./extensions.js";
import {
  AGENT,
  client,
  DASHBOARD_URL,
  errorText,
  LOCAL_REPO,
  recentSessions,
  sessionExecutions,
  streamDeltas,
  TERMINAL,
} from "./kernel.js";
import { isSummarization } from "./messages.js";
import { Picker } from "./picker.js";
import {
  enabled,
  listed,
  models,
  type Optional,
  PREFERENCES,
  setEnabled,
} from "./preferences.js";
import { SettingsView, type ThinkingLevel } from "./settings.js";
import { Transcript } from "./transcript.js";
import { editorTheme, MARK, theme, VERSION, WorkingIndicator } from "./ui.js";

interface StepPayload {
  step_id?: string;
  step_type?: string;
  target?: string;
  reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const USER = userInfo().username;

const newSession = () =>
  `uber-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;

const qualified = (name: string) =>
  name.includes("/") ? name : `${USER}/${name}`;

const COMMANDS: SlashCommand[] = [
  {
    name: "sessions",
    description: "Switch to another of your sessions",
    argumentHint: "[all]",
  },
  { name: "new", description: "Start a new session", argumentHint: "[name]" },
  {
    name: "model",
    description: "Choose the model for this session's next turns",
    argumentHint: "[model]",
  },
  {
    name: "mcp",
    description: "Choose the MCP servers for your sessions",
  },
  {
    name: "extensions",
    description: "Choose the agent's optional extensions for your sessions",
  },
  { name: "session", description: "Show session information and statistics" },
  { name: "settings", description: "Choose the theme and thinking level" },
  {
    name: "fork",
    description:
      "Rerun the latest turn from one of its steps, in a new session",
  },
];

// Completes slash commands only. File completion would list the client's
// disk, while the repository lives in the sandbox.
function commandCompletion(): AutocompleteProvider {
  const commands = new CombinedAutocompleteProvider(
    COMMANDS,
    process.cwd(),
    null,
  );
  return {
    getSuggestions: async (lines, line, col, options) =>
      lines[line]?.startsWith("/")
        ? commands.getSuggestions(lines, line, col, options)
        : null,
    applyCompletion: (lines, line, col, item, prefix) =>
      commands.applyCompletion(lines, line, col, item, prefix),
  };
}

function shortArgs(args: unknown) {
  const values = Object.values((args ?? {}) as Record<string, unknown>).filter(
    (value) => typeof value !== "object",
  );
  const text = values.join(" ").replaceAll("\n", " ");
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

const tokens = (count: number) =>
  count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;

class SplitLine implements Component {
  left = "";
  right = "";

  invalidate() {}

  render(width: number) {
    const right = truncateToWidth(this.right, Math.max(0, width - 2), "");
    const left = truncateToWidth(
      this.left,
      Math.max(0, width - visibleWidth(right) - 3),
    );
    const gap = Math.max(
      1,
      width - 2 - visibleWidth(left) - visibleWidth(right),
    );
    return [` ${left}${" ".repeat(gap)}${right} `];
  }
}

// One session's turns. Switching sessions stops its loops; their pending
// renders check `stopped` and drop out.
interface SessionView {
  name: string;
  repo: string | undefined;
  turns: Execution[];
  current: Execution | undefined;
  latest: Execution | undefined;
  model: string | undefined;
  selected: string | undefined;
  stopped: AbortController;
  // Running subagent calls, and whether each execution checked is one of
  // their subagents.
  subagents: Set<string>;
  children: Map<string, boolean>;
  asked: Set<string>;
  calls: { model: number; tool: number; denied: number };
}

export class App {
  readonly #ui = new TuiAltScreen(new ProcessTerminal(), false);
  readonly #transcript: Transcript;
  readonly #editorContainer = new Container();
  readonly #footerTop = new SplitLine();
  readonly #footerBottom = new SplitLine();
  readonly #editor: CustomEditor;
  #view!: SessionView;
  #indicator: WorkingIndicator | undefined;
  #asking = false;
  #thinking: ThinkingLevel | undefined;
  #enabled = {
    mcpServers: enabled("mcpServers"),
    extensions: enabled("extensions"),
  };
  #exit = () => {};
  readonly #exited = new Promise<void>((resolve) => {
    this.#exit = resolve;
  });

  constructor(
    private readonly initialSession = newSession(),
    private readonly extensions: ClientExtensions,
  ) {
    this.#transcript = new Transcript(this.#ui, extensions);
    this.#thinking = extensions.settings.getDefaultThinkingLevel();
    // pi's editor resolves its app actions through the keybindings setupUi registers.
    this.#editor = new CustomEditor(
      this.#ui,
      editorTheme(),
      getKeybindings() as never,
      {
        paddingX: 1,
        embedWorkingStatus: true,
      },
    );
    this.#editor.setAutocompleteProvider(commandCompletion());
    this.#editor.onSubmit = (text) => void this.#submit(text.trim());
    this.#editor.onEscape = () => {
      const { current } = this.#view;
      if (current)
        void client
          .cancel(current.id)
          .catch((error) => this.#notice(errorText(error)));
    };
    this.#editor.onCtrlD = () => this.#exit();
    this.#editor.onAction("app.clear", () => this.#exit());
    this.#editor.onAction("app.tools.expand", () => this.#toggleTools());
    this.#editorContainer.addChild(this.#editor);

    const header = new Text(
      `${besideMark([`${theme().fg("accent", theme().bold("uber"))} ${theme().fg("dim", `v${VERSION}`)}`])}\n\n` +
        [
          keyHint("app.interrupt", "cancel"),
          rawKeyHint("ctrl+c/ctrl+d", "exit"),
          rawKeyHint("/", "commands"),
          keyHint("app.tools.expand", "expand tools"),
        ].join(theme().fg("muted", " · ")),
      1,
      0,
    );
    const document = new Container();
    document.addChild(new Spacer(1));
    document.addChild(header);
    document.addChild(this.#transcript);
    document.addChild(new Spacer(1));
    const footer = new Container();
    footer.addChild(this.#footerTop);
    footer.addChild(this.#footerBottom);

    for (const component of [document, this.#editorContainer, footer])
      this.#ui.addChild(component);
    const scroll = new ScrollView(document, {
      follow: "end",
      primary: true,
      overscroll: "chain",
    });
    this.#ui.setLayoutRoot(
      new VStack([
        { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        {
          component: this.#editorContainer,
          basis: "auto",
          grow: 0,
          shrink: 1,
          minSize: 3,
        },
        { component: footer, basis: "auto", grow: 0, shrink: 0 },
      ]),
    );
    this.#ui.setFocus(this.#editor);
  }

  async run() {
    this.#ui.start();
    await this.#open(qualified(this.initialSession));
    for (const error of this.extensions.errors) this.#notice(error);
    await this.#exited;
    this.#view.stopped.abort();
    this.#setWorking(undefined);
    this.#transcript.finish("closed");
    this.#ui.stop();
  }

  async #open(session: string) {
    this.#view?.stopped.abort();
    const view: SessionView = {
      name: session,
      repo: undefined,
      turns: [],
      current: undefined,
      latest: undefined,
      model: undefined,
      selected: undefined,
      stopped: new AbortController(),
      subagents: new Set(),
      calls: { model: 0, tool: 0, denied: 0 },
      children: new Map(),
      asked: new Set(),
    };
    this.#view = view;
    this.#transcript.reset();
    this.#setWorking(undefined);
    try {
      view.turns.push(...(await sessionExecutions(session)));
    } catch (error) {
      this.#notice(errorText(error));
    }
    // A new session works on the repository the client runs in; an existing
    // one keeps its own.
    view.repo = view.turns.length
      ? view.turns
          .map((turn) => (turn.input as { repo?: string }).repo)
          .find(Boolean)
      : LOCAL_REPO;
    if (!view.turns.length && !LOCAL_REPO)
      this.#notice(
        "not in a clone of a GitHub repository; the agent works on its default repository, if it has one",
      );
    this.#footer();
    void this.#followTurns(view);
  }

  async #submit(text: string) {
    if (!text) return;
    this.#editor.setText("");
    // Other slash commands, such as prompt templates, are the agent's.
    const command = text.startsWith("/") && text.slice(1).split(/\s+/)[0];
    if (COMMANDS.some(({ name }) => name === command))
      return this.#command(text);
    if (command && this.extensions.commands.has(command))
      return this.#notice(
        `/${command} is a pi extension command, which runs only in pi`,
      );
    const view = this.#view;
    try {
      // A session runs one execution at a time, so a prompt sent mid-run
      // waits in the kernel as the next turn.
      view.turns.push(
        await client.create(
          AGENT,
          {
            task: text,
            ...(view.repo && { repo: view.repo }),
            ...(view.selected && { model: view.selected }),
            ...(this.#thinking && { thinking: this.#thinking }),
            ...(this.#enabled.mcpServers && { mcp: this.#enabled.mcpServers }),
            ...(this.#enabled.extensions && {
              extensions: this.#enabled.extensions,
            }),
          },
          { session: view.name },
        ),
      );
      if (!view.current) void this.#followTurns(view);
    } catch (error) {
      this.#notice(errorText(error));
    }
  }

  async #command(text: string) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    if (name === "sessions") return this.#pickSession(rest[0] === "all");
    if (name === "new") return this.#open(qualified(rest[0] || newSession()));
    if (name === "fork") return this.#pickForkPoint();
    if (name === "session") return this.#sessionInfo();
    if (name === "settings")
      return this.#select(
        new SettingsView(
          this.#ui,
          this.extensions.settings,
          (level) => {
            this.#thinking = level;
            this.#footer();
          },
          () => this.#restoreEditor(),
        ),
      );
    if (name === "model") return this.#pickModel(rest[0]);
    if (name === "mcp") return this.#pickOptional("mcpServers", "MCP servers");
    if (name === "extensions")
      return this.#pickOptional("extensions", "Extensions");
  }

  async #pickSession(all: boolean) {
    const sessions = (await recentSessions()).filter(
      ({ session }) => all || session.startsWith(`${USER}/`),
    );
    this.#select(
      new Picker(
        "Switch session",
        sessions.map(({ session, execution }) => ({
          value: session,
          label: session,
          description: `${execution.status} · ${execution.input?.task ?? ""}`,
        })),
        (session) => {
          this.#restoreEditor();
          void this.#open(session);
        },
        () => this.#restoreEditor(),
      ),
    );
  }

  #pickModel(id: string | undefined) {
    const choose = (model: string) => {
      this.#view.selected = model;
      this.#footer();
    };
    if (id) return choose(id);
    if (!models().length)
      return this.#notice(`list the agent's models in ${PREFERENCES}`);
    const current = this.#view.selected ?? this.#view.model;
    this.#select(
      new Picker(
        "Model",
        models().map((model) => ({
          value: model,
          label: model,
          description: model === current ? "current" : "",
        })),
        (model) => {
          this.#restoreEditor();
          choose(model);
        },
        () => this.#restoreEditor(),
      ),
    );
  }

  #sessionInfo() {
    const { name, repo, turns, latest, model, selected, calls } = this.#view;
    const { input, output } = this.#transcript.usage;
    const line = (label: string, value: string | number) =>
      `${theme().fg("dim", `${label}:`)} ${value}\n`;
    const section = (title: string) => `\n${theme().bold(title)}\n`;
    this.#transcript.info(
      theme().bold("Session Info") +
        "\n\n" +
        line("Name", name) +
        line("Repository", repo ?? "none") +
        line("Model", selected ?? model ?? "the agent's default") +
        line("Thinking level", this.#thinking ?? "the agent's default") +
        line("MCP servers", this.#enabled.mcpServers?.join(", ") || "none") +
        line("Extensions", this.#enabled.extensions?.join(", ") || "none") +
        (latest
          ? line(
              "Latest execution",
              hyperlink(latest.id, `${DASHBOARD_URL}/executions/${latest.id}`),
            )
          : "") +
        section("Calls") +
        line("Turns", turns.length) +
        line("Model calls", calls.model) +
        line(
          "Tool calls",
          `${calls.tool}${calls.denied ? ` (${calls.denied} denied)` : ""}`,
        ) +
        section("Tokens") +
        line("Input", input.toLocaleString()) +
        line("Output", output.toLocaleString()) +
        line("Total", (input + output).toLocaleString()) +
        line("Context", this.#transcript.contextTokens.toLocaleString()),
    );
    this.#ui.requestRender();
  }

  #pickOptional(kind: Optional, title: string) {
    const items = () =>
      listed(kind).map(({ name, enabled }) => ({
        value: name,
        label: name,
        description: enabled ? "on" : "off",
      }));
    if (!items().length)
      return this.#notice(
        `list the agent's ${title.toLowerCase()} in ${PREFERENCES}`,
      );
    const picker: Picker = new Picker(
      title,
      items(),
      (name) => {
        setEnabled(kind, name, !this.#enabled[kind]?.includes(name));
        this.#enabled[kind] = enabled(kind);
        this.#footer();
        picker.setItems(items());
      },
      () => this.#restoreEditor(),
      { confirm: "toggle", cancel: "close" },
    );
    this.#select(picker);
  }

  async #pickForkPoint() {
    const execution = this.#view.latest;
    if (!execution) return this.#notice("nothing to fork yet");
    const events = await client.events(execution.id, { limit: 1000 });
    const points = [];
    for (const event of events) {
      const payload = (event.payload ?? {}) as StepPayload;
      const { step_id: stepId, target } = payload;
      if (
        event.type !== "step.succeeded" ||
        payload.step_type !== "tool_call" ||
        !stepId ||
        !target
      )
        continue;
      const step = await client.getStep(execution.id, stepId);
      points.push({
        value: String(event.eventSeq),
        label: target,
        description: shortArgs(step.args),
      });
    }
    if (points.length === 0)
      return this.#notice("the latest turn has no tool calls to fork from");
    this.#select(
      new Picker(
        "Fork after",
        points,
        async (seq) => {
          this.#restoreEditor();
          const session = qualified(
            `${this.#view.name.split("/").pop()}-fork-${seq}`,
          );
          try {
            await client.fork(execution.id, { atSeq: Number(seq), session });
            await this.#open(session);
          } catch (error) {
            this.#notice(errorText(error));
          }
        },
        () => this.#restoreEditor(),
      ),
    );
  }

  #select(component: Component) {
    this.#editorContainer.clear();
    this.#editorContainer.addChild(component);
    this.#ui.setFocus(component);
    this.#ui.requestRender();
  }

  #restoreEditor() {
    this.#editorContainer.clear();
    this.#editorContainer.addChild(this.#editor);
    this.#ui.setFocus(this.#editor);
    this.#ui.requestRender();
  }

  #toggleTools() {
    this.#transcript.toggleExpanded();
    this.#ui.requestRender();
  }

  async #followTurns(view: SessionView) {
    while (!view.stopped.signal.aborted && !view.current) {
      view.current = view.turns.shift();
      if (!view.current) break;
      view.latest = view.current;
      try {
        await this.#follow(view, view.current);
      } catch (error) {
        if (!view.stopped.signal.aborted) this.#notice(errorText(error));
      }
      view.current = undefined;
    }
    if (!view.stopped.signal.aborted) this.#setWorking(undefined);
  }

  async #follow(view: SessionView, execution: Execution) {
    const active = () => !view.stopped.signal.aborted;
    this.#transcript.user((execution.input as { task?: string }).task ?? "");
    this.#footer();
    const live = new AbortController();
    if (!TERMINAL.has(execution.status)) {
      void streamDeltas(
        execution.id,
        (stepId, data) => {
          if (!active()) return;
          this.#transcript.modelDelta(stepId, data);
          this.#ui.requestRender();
        },
        AbortSignal.any([live.signal, view.stopped.signal]),
      );
    }
    let seq = 0;
    let blocked = false;
    try {
      while (active()) {
        const events = await client.events(execution.id, {
          afterSeq: seq,
          limit: 1000,
        });
        for (const event of events) {
          if (!active()) return;
          seq = event.eventSeq;
          const payload = (event.payload ?? {}) as StepPayload;
          const status = event.type.startsWith("execution.")
            ? event.type.slice("execution.".length)
            : "";
          if (event.type.startsWith("step.") && payload.step_type !== "local") {
            await this.#step(view, execution, event.type, payload);
          } else if (status === "blocked") {
            blocked = true;
            this.#setWorking(
              view.subagents.size > 0
                ? "Waiting for subagents..."
                : "Waiting for approval...",
            );
          } else if (status === "resumed" || status === "started") {
            blocked = false;
            this.#setWorking(
              `Working... (${keyHint("app.interrupt", "to cancel")})`,
            );
          } else if (status === "failed" || status === "cancelled") {
            this.#notice(`${status}: ${payload.reason ?? ""}`);
          }
          if (TERMINAL.has(status)) {
            this.#transcript.finish(status);
            this.#footer();
            return;
          }
        }
        if (blocked && view.subagents.size > 0)
          await this.#askSubagentApproval(view, execution);
        if (events.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      live.abort();
    }
  }

  async #step(
    view: SessionView,
    execution: Execution,
    type: string,
    payload: StepPayload,
  ) {
    const { step_id: stepId, target = "" } = payload;
    if (!stepId) return;
    const step = async () => {
      const found = await client.getStep(execution.id, stepId);
      if (view.stopped.signal.aborted) throw new Error("session closed");
      return found;
    };
    if (type === "step.succeeded" || type === "step.failed")
      view.calls[payload.step_type === "llm_call" ? "model" : "tool"]++;
    if (type === "step.denied" && payload.step_type !== "llm_call")
      view.calls.denied++;
    if (payload.step_type === "llm_call") {
      if (target) view.model = target;
      if (type === "step.executing")
        this.#transcript.modelStarted(
          stepId,
          isSummarization((await step()).args),
        );
      if (type === "step.succeeded")
        this.#transcript.modelFinished(
          stepId,
          ((await step()).result as { message: AssistantMessage }).message,
        );
      if (type === "step.failed" || type === "step.denied") {
        this.#notice(
          `model call ${type.slice("step.".length)}: ${errorText((await step()).error)}`,
        );
      }
      if (payload.usage) this.#transcript.modelUsage(stepId, payload.usage);
      this.#footer();
    } else if (type === "step.proposed") {
      this.#transcript.toolProposed(stepId, target, (await step()).args);
    } else if (type === "step.executing") {
      if (target === "subagent") view.subagents.add(stepId);
      this.#transcript.toolStarted(stepId);
    } else if (type === "step.awaiting_approval") {
      const approval = (await client.listApprovals()).find(
        (candidate) => candidate.stepId === stepId,
      );
      if (approval) this.#askApproval(approval.id, target, approval.message);
    } else if (
      type === "step.succeeded" ||
      type === "step.failed" ||
      type === "step.denied"
    ) {
      view.subagents.delete(stepId);
      this.#transcript.toolFinished(await step());
    }
    this.#ui.requestRender();
  }

  // A subagent's calls are not in the transcript, so its approvals are found
  // among the pending ones and show the call's arguments in the title.
  async #askSubagentApproval(view: SessionView, execution: Execution) {
    if (this.#asking) return;
    for (const approval of await client.listApprovals()) {
      if (view.asked.has(approval.id)) continue;
      if (!view.children.has(approval.executionId)) {
        const child = await client.get(approval.executionId);
        view.children.set(
          child.id,
          child.spawnedBy?.executionId === execution.id,
        );
      }
      if (!view.children.get(approval.executionId)) continue;
      if (view.stopped.signal.aborted) return;
      view.asked.add(approval.id);
      const step = await client.getStep(approval.executionId, approval.stepId);
      this.#askApproval(
        approval.id,
        `subagent: ${step.target} ${shortArgs(step.args)}`,
        approval.message,
      );
      return;
    }
  }

  // pi's own selector, as its extensions use for confirmations. The pending
  // tool card above it shows the call's arguments.
  #askApproval(approvalId: string, target: string, reason: string) {
    this.#asking = true;
    const decide = async (grant: boolean) => {
      this.#asking = false;
      selector.dispose();
      this.#restoreEditor();
      const opts = { decidedBy: USER };
      try {
        await (grant
          ? client.grantApproval(approvalId, opts)
          : client.denyApproval(approvalId, opts));
      } catch (error) {
        this.#notice(errorText(error));
      }
    };
    const selector = new ExtensionSelectorComponent(
      `${target} needs approval${reason ? `\n${reason}` : ""}`,
      ["Approve", "Deny"],
      (option) => void decide(option === "Approve"),
      () => void decide(false),
      { tui: this.#ui, onToggleToolsExpanded: () => this.#toggleTools() },
    );
    this.#select(selector);
  }

  #setWorking(message: string | undefined) {
    this.#indicator?.dispose();
    this.#indicator = message
      ? new WorkingIndicator(this.#ui, message)
      : undefined;
    this.#indicator?.start();
    this.#editor.setWorkingStatusIndicator(this.#indicator as never);
    this.#footer();
  }

  #footer() {
    const { name, repo, latest, model, selected } = this.#view;
    const mcp = this.#enabled.mcpServers;
    const execution = latest
      ? `  •  ${hyperlink(latest.id.slice(0, 18), `${DASHBOARD_URL}/executions/${latest.id}`)}`
      : "";
    this.#footerTop.left = theme().fg(
      "dim",
      `session ${name}${repo ? `  •  ${repo}` : ""}${mcp?.length ? `  •  mcp ${mcp.join(", ")}` : ""}${execution}`,
    );
    const { input, output } = this.#transcript.usage;
    const context = this.#transcript.contextTokens;
    const usage = [
      input && `↑${tokens(input)}`,
      output && `↓${tokens(output)}`,
      context && `ctx ${tokens(context)}`,
    ];
    this.#footerBottom.left = theme().fg(
      "dim",
      usage.filter(Boolean).join(" "),
    );
    this.#footerBottom.right = theme().fg(
      "dim",
      [selected ?? model, this.#thinking].filter(Boolean).join(" • "),
    );
    this.#ui.requestRender();
  }

  #notice(text: string) {
    this.#transcript.notice(text);
    this.#ui.requestRender();
  }
}

function besideMark(lines: string[]) {
  const width = Math.max(...MARK.map(visibleWidth)) + 4;
  const top = Math.floor((MARK.length - lines.length) / 2);
  return MARK.map((mark, row) => {
    const text = lines[row - top];
    return text === undefined
      ? mark
      : `${mark}${" ".repeat(width - visibleWidth(mark))}${text}`;
  }).join("\n");
}
