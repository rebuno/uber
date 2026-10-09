import { existsSync, readFileSync } from "node:fs";

import {
  getSelectListTheme,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  KeybindingsManager,
  Loader,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const BLUE = "\x1b[38;2;6;151;243m";
const BLUE_SHADE = "\x1b[38;2;4;120;195m";
const PURPLE = "\x1b[38;2;139;92;246m";
const PURPLE_SHADE = "\x1b[38;2;111;72;198m";
const INVERSE = "\x1b[7m";
const NORMAL = "\x1b[27m";

// The package's manifest is beside the source, and one level above the build.
export const VERSION: string = ["../package.json", "./package.json"]
  .map((path) => new URL(path, import.meta.url))
  .filter(existsSync)
  .map((url) => JSON.parse(readFileSync(url, "utf8")))
  .find(({ name }) => name === "@rebuno/uber")?.version;

export const MARK = [
  `${BLUE}▗▆▆▄▃▁`,
  `${BLUE}▐██████▆▄▂`,
  `${BLUE}▐█████████▇${BLUE_SHADE}▖`,
  `${BLUE}▐██████████${BLUE_SHADE}█▖`,
  `${BLUE}▐██████████${BLUE_SHADE}██▖`,
  `${BLUE}▐██████████${BLUE_SHADE}███▄`,
  `${BLUE}▐██████████${BLUE_SHADE}████▙`,
  `${BLUE}▐██████████${BLUE_SHADE}█████▙`,
  `${BLUE} ${INVERSE}▅${NORMAL}▀${INVERSE}▂${NORMAL}███████${BLUE_SHADE}██████▘`,
  `${PURPLE}▐▇▆▄▂${BLUE}▔${INVERSE}▅${NORMAL}▀${INVERSE}▂${NORMAL}██${BLUE_SHADE}█${INVERSE}▂${NORMAL}▀${INVERSE}▅${NORMAL}▔${PURPLE_SHADE}▂▖`,
  `${PURPLE}▐█████▇▆▄▃▃${PURPLE_SHADE}▃▄▆▇██▌`,
  `${PURPLE}▝${INVERSE}▃▁${NORMAL}████████${PURPLE_SHADE}██████▌`,
  `    ${PURPLE}${INVERSE}▆${NORMAL}▀${INVERSE}▃▁${NORMAL}███${PURPLE_SHADE}██${INVERSE}▁▃${NORMAL}▀${INVERSE}▆${NORMAL}`,
  `         ${PURPLE}${INVERSE}▆▅${PURPLE_SHADE}▆${NORMAL}`,
].map((line) => `${line}\x1b[0m`);

// pi keeps its active theme on globalThis so every module loader shares it.
// Its components read it there; reading it the same way gives this client's own
// lines the same colors.
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export const theme = () =>
  (globalThis as Record<symbol, unknown>)[THEME_KEY] as Theme;

// pi resolves its "system" theme from colors the terminal reports, through a
// controller it does not export, so the client uses a named theme.
export function setupUi(configured: string | undefined) {
  initTheme(configured ?? "dark");
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.interrupt": {
        defaultKeys: "escape",
        description: "Cancel the running execution",
      },
      "app.clear": { defaultKeys: "ctrl+c", description: "Exit" },
      "app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
      "app.tools.expand": {
        defaultKeys: "ctrl+o",
        description: "Expand tool output",
      },
    }),
  );
}

export function editorTheme(): EditorTheme {
  return {
    borderColor: (text) => theme().fg("borderMuted", text),
    selectList: getSelectListTheme(),
  };
}

export class WorkingIndicator extends Loader {
  readonly kind = "working";

  constructor(ui: TUI, message: string) {
    super(
      ui,
      (text) => theme().fg("accent", text),
      (text) => theme().fg("muted", text),
      message,
    );
  }

  renderInBorder(width: number) {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(
      line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(),
      width,
      "",
    );
  }

  renderSpinnerInBorder(width: number) {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  dispose() {
    this.stop();
  }
}
