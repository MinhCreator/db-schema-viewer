import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import { SchemaUpload } from "@/app/_components/schema/SchemaUpload";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness({ onSQLParsed }: { onSQLParsed: (sql: string, fileName?: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider>
      <button onClick={() => setOpen(true)}>Open import</button>
      {open && <SchemaUpload onClose={() => setOpen(false)} onSQLParsed={onSQLParsed} />}
    </I18nProvider>
  );
}

function openDialog(onSQLParsed: (sql: string, fileName?: string) => void | Promise<void> = vi.fn()) {
  render(<Harness onSQLParsed={onSQLParsed} />);
  const opener = screen.getByRole("button", { name: "Open import" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("SchemaUpload", () => {
  it("is a labelled modal dialog that takes focus", () => {
    openDialog();
    const dialog = screen.getByRole("dialog", { name: "Import Schema" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the opener", () => {
    const opener = openDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the opener when closed with the close button", () => {
    const opener = openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens the file picker from the keyboard on the drop zone", () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Auto-Detect/ }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    const dropZone = screen.getByRole("button", { name: /Drop your file here/ });
    expect(dropZone).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(dropZone, { key: "Enter" });
    fireEvent.keyDown(dropZone, { key: " " });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("toggles a translated example label", () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /^SQL/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show example" }));
    expect(screen.getByRole("button", { name: "Hide example" })).toBeInTheDocument();
  });

  it("clears the file input so the same file can be chosen again", async () => {
    const onSQLParsed = vi.fn(() => { throw new Error("bad schema"); });
    openDialog(onSQLParsed);
    fireEvent.click(screen.getByRole("button", { name: /Auto-Detect/ }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const values: string[] = [];
    Object.defineProperty(input, "value", { configurable: true, get: () => values.at(-1) ?? "C:\\fakepath\\schema.sql", set: (value: string) => { values.push(value); } });
    const file = new File(["CREATE TABLE a (id INT);"], "schema.sql", { type: "text/plain" });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(onSQLParsed).toHaveBeenCalledWith("CREATE TABLE a (id INT);", "schema.sql", expect.any(AbortSignal)));
    expect(values).toContain("");
  });
});
