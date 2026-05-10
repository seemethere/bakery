import { describe, expect, test } from "bun:test";
import { commandAutocompleteToken, fileAutocompleteToken, renderCommandAutocomplete, renderFileAutocomplete, type CommandAutocompleteState, type FileAutocompleteState } from "./autocomplete";

const commandState = (overrides: Partial<CommandAutocompleteState> = {}): CommandAutocompleteState => ({
  active: true,
  token: "",
  start: 0,
  end: 0,
  commands: [],
  selectedIndex: 0,
  loading: false,
  ...overrides,
});

const fileState = (overrides: Partial<FileAutocompleteState> = {}): FileAutocompleteState => ({
  active: true,
  token: "",
  start: 0,
  end: 0,
  files: [],
  selectedIndex: 0,
  loading: false,
  ...overrides,
});

describe("autocomplete tokens", () => {
  test("detects slash commands only at the start of the current line", () => {
    expect(commandAutocompleteToken("/pla", 4)).toEqual({ token: "pla", start: 0, end: 4 });
    expect(commandAutocompleteToken("hello\n/tre", 10)).toEqual({ token: "tre", start: 6, end: 10 });
    expect(commandAutocompleteToken("hello /nope", 11)).toBeNull();
  });

  test("detects file tokens before the cursor", () => {
    expect(fileAutocompleteToken("inspect @src/ma", 15)).toEqual({ token: "src/ma", start: 8, end: 15 });
    expect(fileAutocompleteToken("@", 1)).toEqual({ token: "", start: 0, end: 1 });
    expect(fileAutocompleteToken("email@example.com", 17)).toBeNull();
  });
});

describe("autocomplete rendering", () => {
  test("renders command loading, empty, and selected result states", () => {
    expect(renderCommandAutocomplete(commandState({ loading: true }))).toContain("Loading commands...");
    expect(renderCommandAutocomplete(commandState())).toContain("No command matches");

    const html = renderCommandAutocomplete(commandState({
      selectedIndex: 1,
      commands: [
        { name: "new", source: "builtin", description: "Create session", unsupported: false },
        { name: "plan", source: "skill", argumentHint: "[focus]", unsupported: true },
      ],
    }));

    expect(html).toContain("Slash commands");
    expect(html).toContain("/new");
    expect(html).toContain("/plan");
    expect(html).toContain("skill · UI-only/unsupported");
    expect(html).toContain("<em>[focus]</em>");
    expect(html).toContain('data-command-index="1" class="selected"');
  });

  test("renders file loading, empty, directory, file, and selected states", () => {
    expect(renderFileAutocomplete(fileState({ loading: true }))).toContain("Searching files...");
    expect(renderFileAutocomplete(fileState())).toContain("No file matches");

    const html = renderFileAutocomplete(fileState({
      selectedIndex: 0,
      files: [
        { path: "apps/web/src", type: "directory" },
        { path: "apps/web/src/main.ts", type: "file" },
      ],
    }));

    expect(html).toContain("File matches");
    expect(html).toContain("apps/web/src/");
    expect(html).toContain("apps/web/src/main.ts");
    expect(html).toContain("📁");
    expect(html).toContain("📄");
    expect(html).toContain('data-file-index="0" class="selected"');
  });

  test("returns empty markup when inactive", () => {
    expect(renderCommandAutocomplete(commandState({ active: false }))).toBe("");
    expect(renderFileAutocomplete(fileState({ active: false }))).toBe("");
  });
});
