import { StrictMode, createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTheme } from "@/hooks/use-theme";

const STORAGE_KEY = "db-schema-viewer-theme";
let storageSpy: { mockRestore(): void } | undefined;
beforeEach(() => { localStorage.clear(); localStorage.setItem(STORAGE_KEY, "light"); });
afterEach(() => { cleanup(); storageSpy?.mockRestore(); storageSpy = undefined; });

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

it("cycles light -> dark -> system and persists each mode once per toggle", () => {
  const { result } = renderHook(useTheme, { wrapper: strict });
  expect(result.current.mode).toBe("light");
  const setItem = vi.spyOn(localStorage, "setItem");
  storageSpy = setItem;
  act(() => { result.current.toggleTheme(); });
  expect(result.current.mode).toBe("dark");
  expect(result.current.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(setItem.mock.calls).toEqual([[STORAGE_KEY, "dark"]]);
  act(() => { result.current.toggleTheme(); });
  expect(result.current.mode).toBe("system");
  expect(setItem.mock.calls).toEqual([[STORAGE_KEY, "dark"], [STORAGE_KEY, "system"]]);
});
