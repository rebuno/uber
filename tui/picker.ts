import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

import { theme } from "./ui.js";

export class Picker extends Container implements Focusable {
  readonly #input = new Input();
  readonly #listContainer = new Container();
  #items: SelectItem[];
  #shown: SelectItem[];
  #list: SelectList;
  #focused = false;

  constructor(
    title: string,
    items: SelectItem[],
    private readonly onPick: (value: string) => void,
    private readonly onCancel: () => void,
    actions = { confirm: "select", cancel: "cancel" },
  ) {
    super();
    this.#items = this.#shown = items;
    this.#list = this.#build(items);
    this.addChild(new DynamicBorder());
    this.addChild(new Text(theme().fg("accent", theme().bold(title)), 1, 0));
    this.addChild(this.#input);
    this.addChild(new Spacer(1));
    this.addChild(this.#listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        [
          theme().fg("muted", "type to filter"),
          keyHint("tui.select.confirm", actions.confirm),
          keyHint("tui.select.cancel", actions.cancel),
        ].join(theme().fg("muted", " · ")),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder());
  }

  get focused() {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  handleInput(data: string) {
    const keybindings = getKeybindings();
    const forwarded = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;
    if (forwarded.some((action) => keybindings.matches(data, action))) {
      this.#list.handleInput(data);
      return;
    }
    this.#input.handleInput(data);
    this.#filter();
  }

  // Keeps the filter and the selected item.
  setItems(items: SelectItem[]) {
    const selected = this.#list.getSelectedItem()?.value;
    this.#items = items;
    this.#filter();
    const index = this.#shown.findIndex(({ value }) => value === selected);
    if (index >= 0) this.#list.setSelectedIndex(index);
  }

  #filter() {
    const query = this.#input.getValue();
    this.#shown = query
      ? fuzzyFilter(
          this.#items,
          query,
          (item) => `${item.label} ${item.description ?? ""}`,
        )
      : this.#items;
    this.#list = this.#build(this.#shown);
  }

  #build(items: SelectItem[]) {
    const list = new SelectList(items, 12, getSelectListTheme());
    list.onSelect = (item) => this.onPick(item.value);
    list.onCancel = this.onCancel;
    this.#listContainer.clear();
    this.#listContainer.addChild(list);
    return list;
  }
}
