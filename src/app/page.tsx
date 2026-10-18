"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { getStateFromUrl, generateShareUrl } from "@/lib/sharing/encode-state";
import { createProject, type Project } from "@/lib/project/project";
import { resolveSharedProject, withoutIdConflict } from "@/lib/storage/local-storage";
import { useProjectSession } from "@/hooks/use-project-session";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "@/lib/i18n/context";
import { Landing } from "./_components/landing/Landing";
import { EditorLayout } from "./_components/canvas/EditorLayout";

export default function Home() {
  const { t } = useTranslation();
  const { project, sessionKey, saveStatus, openProject, updateProject, closeProject, flush } = useProjectSession({
    confirmDiscard: () => window.confirm(t("project.confirmDiscardUnsaved")),
    onSourceDropped: () => toast.warning(t("project.sourceDropped")),
  });
  const [mounted, setMounted] = useState(false);
  const initialized = useRef(false);
  const { theme, mode, toggleTheme } = useTheme();

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setMounted(true);
    if (!window.location.hash.startsWith("#d=")) return;
    const shared = getStateFromUrl();
    if (!shared) {
      toast.error(t("page.failedToLoadSharedSchema"), { description: t("page.failedToLoadSharedSchemaDesc") });
      return;
    }
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    openProject(resolveSharedProject({ ...createProject(shared.diagram), ...shared }, navigation?.type === "reload"));
  }, [openProject, t]);

  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      try {
        const url = new URL(generateShareUrl(project.diagram, project.annotations, project.viewSettings));
        window.history.replaceState({}, "", window.location.pathname + window.location.search + url.hash);
      } catch {
        // Local persistence remains available if the browser refuses a very large URL.
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [project]);

  const handleOpen = useCallback((next: Project): boolean => {
    // Save the current project first so an import is compared with what is really stored.
    flush();
    const opened = openProject(withoutIdConflict(next));
    if (!opened) toast.error(t("project.saveError"));
    return opened;
  }, [flush, openProject, t]);

  const handleBack = useCallback(() => {
    if (!closeProject()) { toast.error(t("project.saveError")); return; }
    window.history.replaceState({}, "", window.location.pathname + window.location.search);
  }, [closeProject, t]);

  if (!mounted) return null;
  if (!project) return <Landing onProjectOpened={handleOpen} theme={theme} themeMode={mode} onToggleTheme={toggleTheme} />;
  return (
    <EditorLayout
      key={`${project.diagram.id}-${sessionKey}`}
      project={project}
      onProjectChange={updateProject}
      onProjectOpened={handleOpen}
      saveStatus={saveStatus}
      onSave={flush}
      onBack={handleBack}
      theme={theme}
      themeMode={mode}
      onToggleTheme={toggleTheme}
    />
  );
}
