import { createEffect, createMemo, createSignal, onMount } from "solid-js";

import { deltaClient } from "@/lib/delta-client";
import type {
  ChangedFile,
  OpenRepositoryTarget,
  RepositoryFile,
  RepositoryState,
} from "@/lib/repository";

export type ScrollTarget = {
  path: string;
  request: number;
};

export type SidebarFileMode = "all" | "changed";

type DiffStats = {
  additions: number;
  deletions: number;
  files: number;
};

type ReviewWorkspaceOptions = {
  countFilePatchLines: (file: ChangedFile) => { additions: number; deletions: number };
  readViewed: (root: string) => Record<string, string>;
  writeViewed: (root: string, viewed: Record<string, string>) => void;
};

function selectPathAfterRefresh(nextState: RepositoryState, current: string | null) {
  return current && nextState.treeFiles.includes(current)
    ? current
    : (nextState.files[0]?.path ?? nextState.treeFiles[0] ?? null);
}

export function createReviewWorkspace(options: ReviewWorkspaceOptions) {
  let previewRequestId = 0;
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [previewFile, setPreviewFile] = createSignal<RepositoryFile | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [scrollTarget, setScrollTarget] = createSignal<ScrollTarget | null>(null);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [sidebarFileMode, setSidebarFileMode] = createSignal<SidebarFileMode>("all");
  const [state, setState] = createSignal<RepositoryState | null>(null);
  const [viewed, setViewed] = createSignal<Record<string, string>>({});

  const files = createMemo(() => state()?.files ?? []);
  const treeFiles = createMemo(() => state()?.treeFiles ?? files().map((file) => file.path));
  const repositoryFilePaths = createMemo(() => new Set(treeFiles()));
  const sidebarTreeFiles = createMemo(() =>
    sidebarFileMode() === "changed" ? files().map((file) => file.path) : treeFiles(),
  );
  const selectedChangedFile = createMemo(() =>
    files().find((file) => file.path === selectedPath()),
  );
  const diffStats = createMemo<DiffStats>(() => {
    let additions = 0;
    let deletions = 0;

    for (const file of files()) {
      const counts = options.countFilePatchLines(file);
      additions += counts.additions;
      deletions += counts.deletions;
    }

    return {
      additions,
      deletions,
      files: files().length,
    };
  });

  async function refresh() {
    try {
      const nextState = await deltaClient.getRepositoryState();

      setState(nextState);
      setViewed(options.readViewed(nextState.root));
      setSelectedPath((current) => selectPathAfterRefresh(nextState, current));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  onMount(() => {
    void refresh();
  });

  createEffect(() => {
    const path = selectedPath();
    const currentState = state();
    if (!path || !currentState) {
      setPreviewFile(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    if (files().some((file) => file.path === path)) {
      setPreviewFile(null);
      setPreviewError(null);
      setPreviewLoading(false);
      previewRequestId += 1;
      return;
    }

    if (!repositoryFilePaths().has(path)) {
      setPreviewFile(null);
      setPreviewError(null);
      setPreviewLoading(false);
      previewRequestId += 1;
      return;
    }

    const requestId = ++previewRequestId;
    setPreviewFile(null);
    setPreviewError(null);
    setPreviewLoading(true);

    void deltaClient
      .getRepositoryFile(path, currentState.source)
      .then((file) => {
        if (requestId !== previewRequestId) return;
        setPreviewFile(file);
        setPreviewLoading(false);
      })
      .catch((caught) => {
        if (requestId !== previewRequestId) return;
        setPreviewError(caught instanceof Error ? caught.message : String(caught));
        setPreviewLoading(false);
      });
  });

  function selectPath(path: string) {
    const isChangedPath = files().some((file) => file.path === path);
    if (!isChangedPath && !repositoryFilePaths().has(path)) return;

    setSelectedPath(path);
    setScrollTarget((current) =>
      isChangedPath ? { path, request: (current?.request ?? 0) + 1 } : null,
    );
  }

  function selectedFileIndex() {
    const selected = selectedPath();
    if (!selected) return files().length > 0 ? 0 : -1;
    return files().findIndex((file) => file.path === selected);
  }

  function moveSelectedFile(delta: number) {
    const currentFiles = files();
    if (currentFiles.length === 0) return;

    const currentIndex = selectedFileIndex();
    const boundedIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = Math.min(Math.max(boundedIndex + delta, 0), currentFiles.length - 1);
    const nextFile = currentFiles[nextIndex];
    if (nextFile) selectPath(nextFile.path);
  }

  function toggleCollapsed(file: ChangedFile, isCollapsed: boolean) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (isCollapsed) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }

  function toggleViewed(file: ChangedFile, isViewed: boolean) {
    const root = state()?.root;
    if (!root) return;

    setViewed((current) => {
      const next = { ...current };
      if (isViewed) delete next[file.path];
      else next[file.path] = file.fingerprint;
      options.writeViewed(root, next);
      return next;
    });

    setCollapsed((current) => {
      const next = new Set(current);
      if (isViewed) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }

  function toggleSelectedFileViewed() {
    const file = selectedChangedFile();
    if (!file) return;
    toggleViewed(file, viewed()[file.path] === file.fingerprint);
  }

  function toggleSelectedFileCollapsed() {
    const file = selectedChangedFile();
    if (!file) return;
    toggleCollapsed(file, collapsed().has(file.path) || viewed()[file.path] === file.fingerprint);
  }

  function switchSidebarFileMode(mode: SidebarFileMode) {
    setSidebarFileMode(mode);
    const current = selectedPath();
    const paths = mode === "changed" ? files().map((file) => file.path) : treeFiles();
    if (!current || paths.includes(current)) return;
    const nextPath = paths[0] ?? null;
    setSelectedPath(nextPath);
    setScrollTarget(null);
  }

  function openRepository(target: OpenRepositoryTarget) {
    const root = state()?.root;
    if (root) void deltaClient.openRepository(root, target);
  }

  return {
    collapsed,
    diffStats,
    error,
    files,
    moveSelectedFile,
    openRepository,
    previewError,
    previewFile,
    previewLoading,
    refresh,
    scrollTarget,
    selectPath,
    selectedChangedFile,
    selectedPath,
    sidebarFileMode,
    sidebarTreeFiles,
    switchSidebarFileMode,
    toggleCollapsed,
    toggleSelectedFileCollapsed,
    toggleSelectedFileViewed,
    toggleViewed,
    treeFiles,
    viewed,
    state,
  };
}
