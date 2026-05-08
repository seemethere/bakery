export interface ClipboardCopyEnvironment {
  navigator?: { clipboard?: Pick<Clipboard, "writeText"> };
  document?: Document;
}

function defaultClipboardEnvironment(): ClipboardCopyEnvironment {
  const env: ClipboardCopyEnvironment = {};
  if (typeof navigator !== "undefined") env.navigator = navigator;
  if (typeof document !== "undefined") env.document = document;
  return env;
}

function fallbackCopyText(value: string, doc: Document | undefined): void {
  if (!doc?.body || typeof doc.execCommand !== "function") {
    throw new Error("Clipboard copy is not available in this browser context.");
  }

  const textarea = doc.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.opacity = "0";

  const HTMLElementCtor = doc.defaultView?.HTMLElement;
  const activeElement = HTMLElementCtor && doc.activeElement instanceof HTMLElementCtor ? doc.activeElement : null;
  doc.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (!doc.execCommand("copy")) {
      throw new Error("Clipboard copy was rejected by the browser.");
    }
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

export async function copyTextToClipboard(value: string, env: ClipboardCopyEnvironment = defaultClipboardEnvironment()): Promise<void> {
  const clipboard = env.navigator?.clipboard;
  const writer = clipboard?.writeText;
  if (typeof writer === "function") {
    try {
      await writer.call(clipboard, value);
      return;
    } catch (error) {
      try {
        fallbackCopyText(value, env.document);
        return;
      } catch {
        throw error;
      }
    }
  }

  fallbackCopyText(value, env.document);
}
