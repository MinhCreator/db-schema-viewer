"use client";

import { useEffect } from "react";

interface ShortcutHandlers {
  onSave?: () => void;
  onExport?: () => void;
  onAI?: () => void;
  onEscape?: () => void;
  onImport?: () => void;
  onShare?: () => void;
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True when the key goes to a field the user is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (target instanceof HTMLElement && target.isContentEditable)
    || target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Keys that confirm or cancel an IME composition belong to the field.
      if (e.isComposing) return;
      const isMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Escape still closes panels from a field; the other shortcuts would steal typing keys.
      if (key !== "escape" && isTypingTarget(e.target)) return;

      // Cmd+Shift+S — Share (must check before Cmd+S)
      if (isMod && e.shiftKey && key === "s") {
        e.preventDefault();
        handlers.onShare?.();
        return;
      }

      if (isMod && !e.shiftKey && key === "s") {
        e.preventDefault();
        handlers.onSave?.();
        return;
      }

      if (isMod && key === "e") {
        e.preventDefault();
        handlers.onExport?.();
        return;
      }

      if (isMod && key === "k") {
        e.preventDefault();
        handlers.onAI?.();
        return;
      }

      if (isMod && key === "i") {
        e.preventDefault();
        handlers.onImport?.();
        return;
      }

      if (key === "escape") {
        handlers.onEscape?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlers]);
}
