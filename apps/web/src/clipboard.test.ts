import { describe, expect, test } from "bun:test";
import { copyTextToClipboard, type ClipboardCopyEnvironment } from "./clipboard";

function fallbackEnvironment(execCommand: (command: string) => boolean): ClipboardCopyEnvironment {
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() {},
  };
  return {
    document: {
      body: { appendChild: (node: unknown) => expect(node).toBe(textarea) },
      activeElement: null,
      defaultView: undefined,
      createElement: (tagName: string) => {
        expect(tagName).toBe("textarea");
        return textarea;
      },
      execCommand,
    } as unknown as Document,
  };
}

describe("copyTextToClipboard", () => {
  test("uses navigator clipboard when available", async () => {
    const copied: string[] = [];
    await copyTextToClipboard("hello", {
      navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    } as ClipboardCopyEnvironment);

    expect(copied).toEqual(["hello"]);
  });

  test("falls back to execCommand copy when navigator clipboard is unavailable", async () => {
    const commands: string[] = [];
    await copyTextToClipboard("fallback", fallbackEnvironment((command) => {
      commands.push(command);
      return true;
    }));

    expect(commands).toEqual(["copy"]);
  });

  test("falls back when navigator clipboard rejects", async () => {
    const commands: string[] = [];
    await copyTextToClipboard("fallback", {
      ...fallbackEnvironment((command) => {
        commands.push(command);
        return true;
      }),
      navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    } as ClipboardCopyEnvironment);

    expect(commands).toEqual(["copy"]);
  });
});
