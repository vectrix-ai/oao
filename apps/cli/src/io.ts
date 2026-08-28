import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PickerOption {
  readonly label: string;
  readonly value: string;
}

export interface PickerState {
  readonly query: string;
  readonly selectedIndex: number;
}

export type PickerKey =
  "up" | "down" | "enter" | "backspace" | "escape" | { readonly text: string };

export interface PickerTransition {
  readonly state: PickerState;
  readonly selected?: PickerOption;
}

export function pickerMatches(
  options: readonly PickerOption[],
  query: string,
): readonly PickerOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((option) => {
    const value = `${option.label} ${option.value}`.toLowerCase();
    return terms.every((term) => value.includes(term));
  });
}

export function transitionPicker(
  state: PickerState,
  key: PickerKey,
  options: readonly PickerOption[],
  searchable: boolean,
): PickerTransition {
  if (typeof key === "object") {
    if (!searchable) return { state };
    return {
      state: { query: `${state.query}${key.text}`, selectedIndex: 0 },
    };
  }
  if (key === "backspace") {
    if (!searchable || state.query.length === 0) return { state };
    return {
      state: { query: state.query.slice(0, -1), selectedIndex: 0 },
    };
  }
  if (key === "escape") {
    return searchable && state.query
      ? { state: { query: "", selectedIndex: 0 } }
      : { state };
  }
  const matches = pickerMatches(options, state.query);
  if (matches.length === 0) return { state: { ...state, selectedIndex: 0 } };
  if (key === "up") {
    return {
      state: {
        ...state,
        selectedIndex:
          (state.selectedIndex - 1 + matches.length) % matches.length,
      },
    };
  }
  if (key === "down") {
    return {
      state: {
        ...state,
        selectedIndex: (state.selectedIndex + 1) % matches.length,
      },
    };
  }
  const selected = matches[state.selectedIndex] ?? matches[0];
  return selected ? { state, selected } : { state };
}

export interface SetupIo {
  write(message: string): void;
  question(prompt: string, defaultValue?: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  select(prompt: string, options: readonly PickerOption[]): Promise<string>;
  search(prompt: string, options: readonly PickerOption[]): Promise<string>;
}

export class TerminalIo implements SetupIo {
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  write(message: string): void {
    this.output.write(message);
  }

  async question(prompt: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const readline = createInterface({
      input: this.input,
      output: this.output,
    });
    try {
      const value = (await readline.question(`${prompt}${suffix}: `)).trim();
      return value || defaultValue || "";
    } finally {
      readline.close();
    }
  }

  async secret(prompt: string): Promise<string> {
    if (this.input !== process.stdin || !process.stdin.isTTY) {
      throw new Error("Secret input requires an interactive terminal");
    }
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    this.output.write(`${prompt}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    try {
      return await new Promise<string>((resolve, reject) => {
        let value = "";
        const onData = (chunk: string) => {
          for (const character of chunk) {
            if (character === "\u0003") {
              cleanup();
              reject(new DOMException("Interrupted", "AbortError"));
              return;
            }
            if (character === "\r" || character === "\n") {
              cleanup();
              this.output.write("\n");
              resolve(value);
              return;
            }
            if (character === "\u007f" || character === "\b") {
              if (value.length > 0) {
                value = value.slice(0, -1);
                this.output.write("\b \b");
              }
              continue;
            }
            if (character >= " ") {
              value += character;
              this.output.write("•");
            }
          }
        };
        const cleanup = () => stdin.off("data", onData);
        stdin.on("data", onData);
      });
    } finally {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    }
  }

  async select(
    prompt: string,
    options: readonly PickerOption[],
  ): Promise<string> {
    return await this.picker(prompt, options, false);
  }

  async search(
    prompt: string,
    options: readonly PickerOption[],
  ): Promise<string> {
    return await this.picker(prompt, options, true);
  }

  private async picker(
    prompt: string,
    options: readonly PickerOption[],
    searchable: boolean,
  ): Promise<string> {
    if (options.length === 0) throw new Error("Selection requires options");
    if (this.input !== process.stdin || !process.stdin.isTTY) {
      throw new Error("Interactive selection requires a terminal");
    }
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let state: PickerState = { query: "", selectedIndex: 0 };
    let renderedLines = 0;
    const render = () => {
      const matches = pickerMatches(options, state.query);
      const windowSize = searchable ? 8 : options.length;
      const start = Math.max(0, state.selectedIndex - windowSize + 1);
      const visible = matches.slice(start, start + windowSize);
      const lines = [
        searchable
          ? `${prompt} — type to search, ↑/↓ to select, Enter to confirm`
          : `${prompt} — use ↑/↓ and Enter`,
      ];
      if (searchable) lines.push(`Search: ${state.query}`);
      if (visible.length === 0) lines.push("  No matching models");
      else {
        visible.forEach((option, index) => {
          const selected = start + index === state.selectedIndex;
          lines.push(`${selected ? "❯" : " "} ${option.label}`);
        });
      }
      if (renderedLines > 0)
        this.output.write(`\u001b[${renderedLines}A\u001b[0J`);
      this.output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    this.output.write("\u001b[?25l");
    render();
    try {
      const selected = await new Promise<PickerOption>((resolve, reject) => {
        const onKeypress = (
          character: string | undefined,
          key: {
            readonly name?: string;
            readonly ctrl?: boolean;
            readonly meta?: boolean;
          } = {},
        ) => {
          if (key.ctrl && key.name === "c") {
            cleanup();
            reject(new DOMException("Interrupted", "AbortError"));
            return;
          }
          let pickerKey: PickerKey | undefined;
          if (key.name === "up" || key.name === "down") pickerKey = key.name;
          else if (key.name === "return" || key.name === "enter")
            pickerKey = "enter";
          else if (key.name === "backspace") pickerKey = "backspace";
          else if (key.name === "escape") pickerKey = "escape";
          else if (
            searchable &&
            character &&
            [...character].every((value) => {
              const codePoint = value.codePointAt(0) ?? 0;
              return codePoint > 31 && codePoint !== 127;
            }) &&
            !key.ctrl &&
            !key.meta
          )
            pickerKey = { text: character };
          if (!pickerKey) return;
          const transition = transitionPicker(
            state,
            pickerKey,
            options,
            searchable,
          );
          state = transition.state;
          if (transition.selected) {
            cleanup();
            resolve(transition.selected);
            return;
          }
          render();
        };
        const cleanup = () => stdin.off("keypress", onKeypress);
        stdin.on("keypress", onKeypress);
      });
      if (renderedLines > 0)
        this.output.write(`\u001b[${renderedLines}A\u001b[0J`);
      renderedLines = 0;
      this.output.write(`✓ ${prompt}: ${selected.label}\n`);
      return selected.value;
    } catch (error) {
      if (renderedLines > 0)
        this.output.write(`\u001b[${renderedLines}A\u001b[0J`);
      renderedLines = 0;
      throw error;
    } finally {
      this.output.write("\u001b[?25h");
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    }
  }
}
