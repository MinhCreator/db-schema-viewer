import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

function setup() {
  const handlers = { onSave: vi.fn(), onExport: vi.fn(), onAI: vi.fn(), onEscape: vi.fn(), onImport: vi.fn(), onShare: vi.fn() };
  renderHook(() => useKeyboardShortcuts(handlers));
  return handlers;
}

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body.querySelector<HTMLElement>("[data-target]")!;
}

describe("useKeyboardShortcuts", () => {
  it("fires shortcuts outside of text fields", () => {
    const handlers = setup();
    const event = press(mount("<button data-target>Go</button>"), { key: "k", metaKey: true });
    expect(handlers.onAI).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    press(document.body, { key: "s", ctrlKey: true, shiftKey: true });
    expect(handlers.onShare).toHaveBeenCalledOnce();
  });

  it.each([
    ["input", '<input data-target type="text" />'],
    ["search input", '<input data-target type="search" />'],
    ["textarea", "<textarea data-target></textarea>"],
    ["select", "<select data-target><option>a</option></select>"],
    ["contenteditable", '<div contenteditable="true"><span data-target>x</span></div>'],
  ])("ignores modifier shortcuts while typing in a %s", (_name, html) => {
    const handlers = setup();
    const target = mount(html);
    for (const key of ["s", "e", "k", "i"]) {
      const event = press(target, { key, metaKey: true });
      expect(event.defaultPrevented).toBe(false);
    }
    press(target, { key: "s", metaKey: true, shiftKey: true });
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(handlers.onExport).not.toHaveBeenCalled();
    expect(handlers.onAI).not.toHaveBeenCalled();
    expect(handlers.onImport).not.toHaveBeenCalled();
    expect(handlers.onShare).not.toHaveBeenCalled();
  });

  it("still fires shortcuts from a checkbox", () => {
    const handlers = setup();
    press(mount('<input data-target type="checkbox" />'), { key: "i", metaKey: true });
    expect(handlers.onImport).toHaveBeenCalledOnce();
  });

  it("keeps Escape working from a text field", () => {
    const handlers = setup();
    press(mount('<input data-target type="text" />'), { key: "Escape" });
    expect(handlers.onEscape).toHaveBeenCalledOnce();
  });

  it("ignores keys pressed during IME composition", () => {
    const handlers = setup();
    press(document.body, { key: "Escape", isComposing: true });
    expect(handlers.onEscape).not.toHaveBeenCalled();
  });
});
