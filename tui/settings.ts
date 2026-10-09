import {
  getSettingsListTheme,
  initTheme,
  type SettingsManager,
  ThemeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, type TUI } from "@earendil-works/pi-tui";

export type ThinkingLevel = Parameters<
  SettingsManager["setDefaultThinkingLevel"]
>[0];

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

class ThemeMenu extends ThemeSelectorComponent {
  handleInput(data: string) {
    this.getSelectList().handleInput(data);
  }
}

// The settings that apply to this client, saved in pi's settings.json.
export class SettingsView extends SettingsList {
  constructor(
    ui: TUI,
    settings: SettingsManager,
    onThinking: (level: ThinkingLevel) => void,
    onClose: () => void,
  ) {
    const applyTheme = (name: string) => {
      initTheme(name);
      ui.invalidate();
      ui.requestRender();
    };
    super(
      [
        {
          id: "theme",
          label: "Theme",
          description: "Color theme for the interface",
          currentValue: settings.getTheme() ?? "dark",
          submenu: (current, done) =>
            new ThemeMenu(
              current,
              (name) => done(name),
              () => {
                applyTheme(current);
                done();
              },
              applyTheme,
            ),
        },
        {
          id: "thinking",
          label: "Thinking level",
          description: "How much the model reasons on your turns",
          currentValue: settings.getDefaultThinkingLevel() ?? "agent default",
          values: THINKING_LEVELS,
        },
      ],
      10,
      getSettingsListTheme(),
      (id, value) => {
        if (id === "theme") {
          settings.setTheme(value);
          applyTheme(value);
        } else {
          settings.setDefaultThinkingLevel(value as ThinkingLevel);
          onThinking(value as ThinkingLevel);
        }
      },
      onClose,
    );
  }
}
