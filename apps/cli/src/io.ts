import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface SetupIo {
  write(message: string): void;
  question(prompt: string, defaultValue?: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  select(
    prompt: string,
    options: readonly { readonly label: string; readonly value: string }[],
  ): Promise<string>;
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
    options: readonly { readonly label: string; readonly value: string }[],
  ): Promise<string> {
    if (options.length === 0) throw new Error("Selection requires options");
    this.write(`${prompt}\n`);
    options.forEach((option, index) => {
      this.write(`  ${index + 1}. ${option.label}\n`);
    });
    while (true) {
      const answer = await this.question("Choose", "1");
      const selected = options[Number(answer) - 1];
      if (selected) return selected.value;
      this.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  }
}
