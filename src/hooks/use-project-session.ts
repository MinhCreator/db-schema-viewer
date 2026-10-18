"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveProject } from "@/lib/storage/local-storage";
import type { Project } from "@/lib/project/project";

export type SaveStatus = "saving" | "saved" | "error";

export interface ProjectSessionOptions {
  /** Asked when unsaved work would be lost; returning true discards it. */
  confirmDiscard?: () => boolean;
  /** Called once per project when storage is full and its source code was not saved. */
  onSourceDropped?: () => void;
}

export function useProjectSession(options: ProjectSessionOptions = {}) {
  const [sessionKey, setSessionKey] = useState(0);
  const [project, setProject] = useState<Project | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const current = useRef<Project | null>(null);
  const persisted = useRef<Project | null>(null);
  const sourceDroppedFor = useRef<string | null>(null);
  const callbacks = useRef(options);
  useEffect(() => { callbacks.current = options; });

  const flush = useCallback(() => {
    if (!current.current || current.current === persisted.current) return true;
    try {
      const { sourceDropped } = saveProject(current.current);
      persisted.current = current.current;
      setSaveStatus("saved");
      const id = current.current.diagram.id;
      if (sourceDropped && sourceDroppedFor.current !== id) {
        sourceDroppedFor.current = id;
        callbacks.current.onSourceDropped?.();
      }
      return true;
    } catch {
      setSaveStatus("error");
      return false;
    }
  }, []);

  /** Saves pending work, or lets the user knowingly discard it when saving fails. */
  const leaveCurrent = useCallback(() => {
    if (flush()) return true;
    return callbacks.current.confirmDiscard?.() ?? false;
  }, [flush]);

  const openProject = useCallback((next: Project) => {
    // Retain an unsaved project in memory until the user retries, exports or discards it.
    if (!leaveCurrent()) return false;
    current.current = next;
    setProject(next);
    setSessionKey((key) => key + 1);
    setSaveStatus("saving");
    return true;
  }, [leaveCurrent]);

  const updateProject = useCallback((update: Partial<Project> | ((project: Project) => Partial<Project>)) => {
    if (!current.current) return;
    const patch = typeof update === "function" ? update(current.current) : update;
    const next = { ...current.current, ...patch, updatedAt: new Date().toISOString() };
    current.current = next;
    setProject(next);
    setSaveStatus("saving");
  }, []);

  const closeProject = useCallback(() => {
    if (!leaveCurrent()) return false;
    current.current = null;
    setProject(null);
    setSaveStatus("saved");
    return true;
  }, [leaveCurrent]);

  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(flush, 500);
    return () => clearTimeout(timer);
  }, [project, flush]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!flush()) event.preventDefault();
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  return { project, sessionKey, saveStatus, openProject, updateProject, closeProject, flush };
}
