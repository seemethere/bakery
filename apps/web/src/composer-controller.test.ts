import { describe, expect, test } from "bun:test";
import { closedCommandAutocompleteState, closedFileAutocompleteState, type CommandAutocompleteState, type FileAutocompleteState } from "./autocomplete";
import { handleComposerKeydown, type ComposerControlOptions } from "./composer-controller";

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent & { prevented: boolean } {
  return {
    key,
    shiftKey: false,
    altKey: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  } as KeyboardEvent & { prevented: boolean };
}

function optionsWithState(state: {
  command?: CommandAutocompleteState;
  file?: FileAutocompleteState;
  chooseCommand?: () => void;
  chooseFile?: () => void;
  patch?: (kind: "command" | "file") => void;
  send?: (followUp: boolean) => void;
}): ComposerControlOptions {
  return {
    commandAutocomplete: () => state.command ?? closedCommandAutocompleteState(),
    fileAutocomplete: () => state.file ?? closedFileAutocompleteState(),
    imagePickerActive: () => false,
    setImagePickerActive: () => {},
    setNotice: () => {},
    render: () => {},
    sendFromInput: (followUp) => state.send?.(followUp),
    handleImageFiles: () => {},
    updatePromptDraft: () => {},
    removePromptImage: () => {},
    closeFileAutocomplete: () => {},
    closeCommandAutocomplete: () => {},
    patchAutocompleteSelection: (kind) => state.patch?.(kind),
    chooseCommandAutocomplete: () => state.chooseCommand?.(),
    chooseFileAutocomplete: () => state.chooseFile?.(),
  };
}

describe("composer autocomplete keyboard handling", () => {
  test("uses the latest slash command autocomplete state for arrows and enter", () => {
    let command: CommandAutocompleteState = {
      active: true,
      token: "",
      start: 0,
      end: 1,
      loading: true,
      selectedIndex: 0,
      commands: [],
    };
    const patched: string[] = [];
    let choseCommand = false;
    const options = optionsWithState({
      get command() { return command; },
      patch: (kind: "command" | "file") => patched.push(kind),
      chooseCommand: () => { choseCommand = true; },
    });

    command = {
      ...command,
      loading: false,
      commands: [
        { name: "new", source: "builtin", unsupported: false },
        { name: "plan", source: "skill", unsupported: false },
      ],
    };

    const arrow = keyEvent("ArrowDown");
    handleComposerKeydown(arrow, options);
    expect(arrow.prevented).toBe(true);
    expect(command.selectedIndex).toBe(1);
    expect(patched).toEqual(["command"]);

    const enter = keyEvent("Enter");
    handleComposerKeydown(enter, options);
    expect(enter.prevented).toBe(true);
    expect(choseCommand).toBe(true);
  });

  test("uses the latest file autocomplete state for arrows and tab", () => {
    let file: FileAutocompleteState = {
      active: true,
      token: "",
      start: 0,
      end: 1,
      loading: true,
      selectedIndex: 0,
      files: [],
    };
    const patched: string[] = [];
    let choseFile = false;
    const options = optionsWithState({
      get file() { return file; },
      patch: (kind: "command" | "file") => patched.push(kind),
      chooseFile: () => { choseFile = true; },
    });

    file = {
      ...file,
      loading: false,
      files: [
        { path: "apps/web/src", type: "directory" },
        { path: "apps/web/src/main.ts", type: "file" },
      ],
    };

    const arrow = keyEvent("ArrowDown");
    handleComposerKeydown(arrow, options);
    expect(arrow.prevented).toBe(true);
    expect(file.selectedIndex).toBe(1);
    expect(patched).toEqual(["file"]);

    const tab = keyEvent("Tab");
    handleComposerKeydown(tab, options);
    expect(tab.prevented).toBe(true);
    expect(choseFile).toBe(true);
  });
});
