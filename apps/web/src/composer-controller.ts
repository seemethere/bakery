import type { CommandAutocompleteState, FileAutocompleteState } from "./autocomplete";
import { isSupportedImageFile } from "./prompt-images";

export type ComposerControlOptions = {
  commandAutocomplete: CommandAutocompleteState;
  fileAutocomplete: FileAutocompleteState;
  imagePickerActive: () => boolean;
  setImagePickerActive: (active: boolean) => void;
  setNotice: (notice: string) => void;
  render: () => void;
  sendFromInput: (followUp: boolean) => void;
  handleImageFiles: (files: FileList | File[]) => void | Promise<void>;
  updatePromptDraft: (input: HTMLTextAreaElement) => void;
  removePromptImage: (id: string) => void;
  closeFileAutocomplete: () => void;
  closeCommandAutocomplete: () => void;
  patchAutocompleteSelection: (kind: "command" | "file") => void;
  chooseCommandAutocomplete: () => void;
  chooseFileAutocomplete: () => void;
};

export function openComposerImagePicker(options: Pick<ComposerControlOptions, "setImagePickerActive" | "setNotice" | "render" | "handleImageFiles">): void {
  options.setImagePickerActive(true);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  input.multiple = true;
  input.style.position = "fixed";
  input.style.left = "-10000px";
  input.style.top = "0";
  input.addEventListener("change", () => {
    options.setImagePickerActive(false);
    const files = Array.from(input.files ?? []);
    options.setNotice(files.length > 0
      ? `Selected ${files.length} image file${files.length === 1 ? "" : "s"}: ${files.map((file) => `${file.name || "unnamed"}${file.type ? ` (${file.type})` : ""}`).join(", ")}`
      : "File picker returned no files.");
    options.render();
    void options.handleImageFiles(files);
    input.remove();
  }, { once: true });
  document.body.append(input);
  input.click();
}

export function bindComposerControls(root: ParentNode, options: ComposerControlOptions): void {
  root.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", () => options.sendFromInput(false));
  root.querySelector<HTMLButtonElement>("#followUp")?.addEventListener("click", () => options.sendFromInput(true));
  root.querySelector<HTMLButtonElement>("#attachImages")?.addEventListener("click", () => openComposerImagePicker(options));
  root.querySelectorAll<HTMLButtonElement>("[data-remove-image-id]").forEach((button) => {
    button.addEventListener("click", () => options.removePromptImage(button.dataset.removeImageId ?? ""));
  });

  root.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragover", (event) => {
    const items = Array.from(event.dataTransfer?.items ?? []);
    const hasPotentialFileDrop = items.length === 0 || items.some((item) => item.kind === "file" || item.type.startsWith("image/"));
    if (!hasPotentialFileDrop) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    (event.currentTarget as HTMLElement).classList.add("dragging-image");
  });
  root.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragleave", (event) => {
    (event.currentTarget as HTMLElement).classList.remove("dragging-image");
  });
  root.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    event.preventDefault();
    (event.currentTarget as HTMLElement).classList.remove("dragging-image");
    if (!files || files.length === 0) {
      options.setNotice("Drop image files here to attach them to the prompt.");
      options.render();
      return;
    }
    void options.handleImageFiles(files);
  });

  root.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => options.updatePromptDraft(event.currentTarget as HTMLTextAreaElement));
  root.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("paste", (event) => {
    const files = event.clipboardData?.files;
    if (files && Array.from(files).some((file) => isSupportedImageFile(file))) void options.handleImageFiles(files);
  });
  root.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("blur", () => {
    window.setTimeout(() => {
      const focused = root.querySelector<HTMLElement>(":focus");
      if (options.imagePickerActive() || focused?.id === "prompt" || focused?.closest(".file-autocomplete") || focused?.closest(".command-autocomplete")) return;
      options.closeFileAutocomplete();
      options.closeCommandAutocomplete();
      options.render();
    }, 120);
  });
  root.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("keydown", (event) => handleComposerKeydown(event, options));
}

function handleComposerKeydown(event: KeyboardEvent, options: ComposerControlOptions): void {
  if (options.commandAutocomplete.active) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const count = Math.max(1, options.commandAutocomplete.commands.length);
      options.commandAutocomplete.selectedIndex = (options.commandAutocomplete.selectedIndex + direction + count) % count;
      options.patchAutocompleteSelection("command");
      return;
    }
    if ((event.key === "Tab" || event.key === "Enter") && options.commandAutocomplete.commands.length > 0) {
      event.preventDefault();
      options.chooseCommandAutocomplete();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      options.closeCommandAutocomplete();
      options.render();
      return;
    }
  }

  if (options.fileAutocomplete.active) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const count = Math.max(1, options.fileAutocomplete.files.length);
      options.fileAutocomplete.selectedIndex = (options.fileAutocomplete.selectedIndex + direction + count) % count;
      options.patchAutocompleteSelection("file");
      return;
    }
    if ((event.key === "Tab" || event.key === "Enter") && options.fileAutocomplete.files.length > 0) {
      event.preventDefault();
      options.chooseFileAutocomplete();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      options.closeFileAutocomplete();
      options.render();
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    options.sendFromInput(event.altKey);
  }
}
