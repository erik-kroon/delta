import {
  CodeView,
  DEFAULT_CODE_VIEW_FILE_METRICS,
  DEFAULT_CODE_VIEW_LAYOUT,
  type CodeViewOptions,
  type SmoothScrollSettings,
} from "@pierre/diffs";
import { FileTree, type FileTreeRowDecoration, type GitStatusEntry } from "@pierre/trees";
import { createHotkey } from "@tanstack/solid-hotkeys";
import { createFileRoute } from "@tanstack/solid-router";
import {
  AlignJustify,
  Check,
  ListOrdered,
  PaintBucket,
  RefreshCcw,
  Search,
  Settings,
  SplitSquareVertical,
  WrapText,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";

import { KbdShortcut } from "@/components/kbd";
import { buildCodeViewItemModel, diffItemId } from "@/lib/code-view-items";
import { createReviewWorkspace, type ScrollTarget } from "@/lib/review-workspace";
import type { OpenRepositoryTarget } from "@/lib/repository";
import type { ChangedFile, DiffSection, GitFileStatus, RepositoryFile } from "@/lib/repository";

export const Route = createFileRoute("/")({
  component: DeltaApp,
});

type DiffViewPreferences = {
  backgrounds: boolean;
  diffStyle: "split" | "unified";
  lineNumbers: boolean;
  wordWrap: boolean;
};

const defaultDiffViewPreferences: DiffViewPreferences = {
  backgrounds: true,
  diffStyle: "split",
  lineNumbers: true,
  wordWrap: false,
};

const diffViewPreferencesStorageKey = "delta:diff-view-preferences";

const sectionLabel: Record<DiffSection["kind"], string> = {
  commit: "Commit",
  "pull-request": "Pull request",
  staged: "Staged",
  unstaged: "Unstaged",
};

const statusForTree: Record<GitFileStatus, GitStatusEntry["status"]> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  untracked: "untracked",
};

const codeViewLayout = {
  ...DEFAULT_CODE_VIEW_LAYOUT,
  gap: 0,
  paddingBottom: 0,
  paddingTop: 0,
};

const codeViewItemMetrics = {
  ...DEFAULT_CODE_VIEW_FILE_METRICS,
  diffHeaderHeight: 44,
  lineHeight: 23,
};

const codeViewSmoothScrollSettings = {
  omega: 0.05,
  positionEpsilon: 0.75,
  velocityEpsilon: 0.08,
} satisfies SmoothScrollSettings;

const codeViewScrollOverscan = 2_400;

const patchLineCounts = new WeakMap<DiffSection, { additions: number; deletions: number }>();

type ScrollPerfResult = {
  averageFrameMs: number;
  droppedFrames: number;
  durationMs: number;
  frames: number;
  longTasks: number;
  maxFrameMs: number;
  p95FrameMs: number;
  scrollDistance: number;
};

const codeViewUnsafeCSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: 14px;
    --diffs-line-height: 23px;
    --diffs-light-bg: #ffffff;
    --diffs-dark-bg: #191919;
    scrollbar-color: rgb(128 128 128 / 0.72) transparent;
    scrollbar-width: thin;
  }

  ::-webkit-scrollbar {
    height: 6px;
    width: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: rgb(128 128 128 / 0.72);
    border-radius: 999px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: rgb(128 128 128 / 0.86);
  }

  [data-diffs-header='custom'] {
    background: var(--surface);
    min-height: 44px;
    position: relative;
    z-index: 2;
  }

  [data-diffs-header='custom'] slot {
    display: block;
  }
`;

function compactPath(path: string) {
  const homePath = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
  const parts = homePath.split("/").filter(Boolean);

  if (parts.length <= 3) return homePath;

  const prefix = homePath.startsWith("/") ? "/" : "";
  const [first, ...rest] = parts;
  const last = rest.pop();
  const middle = rest.map((part) => part[0]).join("/");
  return `${prefix}${first}/${middle ? `${middle}/` : ""}${last}`;
}

function repositoryName(path: string | undefined) {
  if (!path) return "Loading";
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function countPatchLines(patch: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

function countSectionPatchLines(section: DiffSection) {
  const cached = patchLineCounts.get(section);
  if (cached) return cached;

  const counts =
    section.loadState === "loaded"
      ? countPatchLines(section.patch)
      : {
          additions: section.summary?.additions ?? 0,
          deletions: section.summary?.deletions ?? 0,
        };
  patchLineCounts.set(section, counts);
  return counts;
}

function countFilePatchLines(file: ChangedFile) {
  let additions = 0;
  let deletions = 0;

  for (const section of file.sections) {
    const counts = countSectionPatchLines(section);
    additions += counts.additions;
    deletions += counts.deletions;
  }

  return { additions, deletions };
}

function formatFileStatsText(counts: { additions: number; deletions: number }) {
  const parts = [];
  if (counts.additions > 0) parts.push(`+${formatCount(counts.additions)}`);
  if (counts.deletions > 0) parts.push(`-${formatCount(counts.deletions)}`);
  return parts.join(" ");
}

function viewedStorageKey(root: string) {
  return `delta:viewed:${root}`;
}

function readViewed(root: string) {
  try {
    return JSON.parse(localStorage.getItem(viewedStorageKey(root)) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function writeViewed(root: string, viewed: Record<string, string>) {
  localStorage.setItem(viewedStorageKey(root), JSON.stringify(viewed));
}

function isDiffViewPreferences(value: unknown): value is Partial<DiffViewPreferences> {
  if (!value || typeof value !== "object") return false;
  const preferences = value as Partial<DiffViewPreferences>;
  return (
    (preferences.diffStyle === undefined ||
      preferences.diffStyle === "split" ||
      preferences.diffStyle === "unified") &&
    (preferences.backgrounds === undefined || typeof preferences.backgrounds === "boolean") &&
    (preferences.lineNumbers === undefined || typeof preferences.lineNumbers === "boolean") &&
    (preferences.wordWrap === undefined || typeof preferences.wordWrap === "boolean")
  );
}

function readDiffViewPreferences() {
  if (typeof localStorage === "undefined") return defaultDiffViewPreferences;

  try {
    const stored = JSON.parse(localStorage.getItem(diffViewPreferencesStorageKey) ?? "null");
    if (!isDiffViewPreferences(stored)) return defaultDiffViewPreferences;
    return { ...defaultDiffViewPreferences, ...stored };
  } catch {
    return defaultDiffViewPreferences;
  }
}

function writeDiffViewPreferences(preferences: DiffViewPreferences) {
  localStorage.setItem(diffViewPreferencesStorageKey, JSON.stringify(preferences));
}

function activeElementDeep(root: Document | ShadowRoot = document): Element | null {
  const activeElement = root.activeElement;
  if (!activeElement?.shadowRoot) return activeElement;
  return activeElementDeep(activeElement.shadowRoot) ?? activeElement;
}

function isEditableShortcutTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target : activeElementDeep();
  const focusedElement = activeElementDeep();
  if (!element && !focusedElement) return false;

  const interactiveSelector =
    "input, textarea, select, button, a[href], [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']";

  return [element, focusedElement].some((candidate) =>
    Boolean(candidate?.closest(interactiveSelector)),
  );
}

function shouldRunScrollPerfBenchmark() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("delta-scroll-perf") === "1";
}

function publishScrollPerfResult(result: ScrollPerfResult) {
  console.table(result);
  (
    window as Window & {
      __DELTA_SCROLL_PERF__?: ScrollPerfResult;
    }
  ).__DELTA_SCROLL_PERF__ = result;
  window.dispatchEvent(new CustomEvent("delta-scroll-perf", { detail: result }));
}

function runScrollPerfBenchmark(container: HTMLElement) {
  const params = new URLSearchParams(window.location.search);
  const durationMs = Number(params.get("duration") ?? 2_000);
  const startTop = container.scrollTop;
  const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
  const scrollDistance = Math.min(maxScrollTop, Number(params.get("distance") ?? 8_000));
  const targetTop = Math.min(startTop + scrollDistance, maxScrollTop);
  const frameTimes: number[] = [];
  let animationFrame = 0;
  let lastFrameTime = 0;
  let longTasks = 0;

  const observer =
    "PerformanceObserver" in window
      ? new PerformanceObserver((list) => {
          longTasks += list.getEntries().length;
        })
      : undefined;

  try {
    observer?.observe({ entryTypes: ["longtask"] });
  } catch {
    observer?.disconnect();
  }

  const finish = () => {
    observer?.disconnect();
    const sortedFrameTimes = [...frameTimes].sort((a, b) => a - b);
    const frameSum = frameTimes.reduce((sum, frameTime) => sum + frameTime, 0);
    const result: ScrollPerfResult = {
      averageFrameMs: Number((frameSum / Math.max(frameTimes.length, 1)).toFixed(2)),
      droppedFrames: frameTimes.filter((frameTime) => frameTime > 20).length,
      durationMs,
      frames: frameTimes.length,
      longTasks,
      maxFrameMs: Number(Math.max(0, ...frameTimes).toFixed(2)),
      p95FrameMs: Number(
        (sortedFrameTimes[Math.floor(sortedFrameTimes.length * 0.95)] ?? 0).toFixed(2),
      ),
      scrollDistance: Math.round(targetTop - startTop),
    };
    publishScrollPerfResult(result);
  };

  const start = (startTime: number) => {
    lastFrameTime = startTime;
    const step = (time: number) => {
      frameTimes.push(time - lastFrameTime);
      lastFrameTime = time;

      const progress = Math.min((time - startTime) / durationMs, 1);
      container.scrollTop = startTop + (targetTop - startTop) * progress;

      if (progress < 1) {
        animationFrame = window.requestAnimationFrame(step);
        return;
      }

      finish();
    };

    animationFrame = window.requestAnimationFrame(step);
  };

  animationFrame = window.requestAnimationFrame(start);
  return () => {
    window.cancelAnimationFrame(animationFrame);
    observer?.disconnect();
  };
}

function createFileHeader({
  file,
  isCollapsed,
  isViewed,
  onToggleCollapsed,
  onLoadSection,
  section,
  sectionCount,
}: {
  file: ChangedFile;
  isCollapsed: boolean;
  isViewed: boolean;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  section: DiffSection;
  sectionCount: number;
}) {
  const header = document.createElement("div");
  header.className = `delta-file-header${isViewed ? " viewed" : ""}`;
  header.role = "button";
  header.tabIndex = 0;
  header.ariaExpanded = String(!isCollapsed);
  header.ariaLabel = `${isCollapsed ? "Expand" : "Collapse"} ${file.path}`;
  header.addEventListener("click", () => onToggleCollapsed(file, isCollapsed));
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggleCollapsed(file, isCollapsed);
  });

  const toggle = document.createElement("span");
  toggle.className = "delta-file-toggle";
  toggle.ariaHidden = "true";
  toggle.innerHTML = '<span aria-hidden class="delta-chevron"></span>';
  toggle.dataset.state = isCollapsed ? "collapsed" : "expanded";

  const heading = document.createElement("div");
  heading.className = "delta-file-heading";

  const path = document.createElement("div");
  path.className = "delta-file-path";
  path.append(document.createTextNode(file.path));
  heading.append(path);

  if (file.oldPath) {
    const oldPath = document.createElement("div");
    oldPath.className = "delta-file-old-path";
    oldPath.textContent = file.oldPath;
    heading.append(oldPath);
  }

  header.append(toggle, heading);

  if (section.loadState !== "loaded") {
    const summary = document.createElement("div");
    summary.className = `delta-section-summary ${section.loadState}`;
    summary.textContent = section.summary?.message ?? "Diff content unavailable.";
    heading.append(summary);
  }

  if (sectionCount > 1) {
    const sectionBadge = document.createElement("div");
    sectionBadge.className = `delta-section-badge ${section.kind}`;
    sectionBadge.textContent = sectionLabel[section.kind];
    header.append(sectionBadge);
  }

  const stats = countSectionPatchLines(section);
  const diffStats = document.createElement("div");
  diffStats.className = "delta-file-stats";

  if (stats.deletions > 0) {
    const deletions = document.createElement("span");
    deletions.className = "negative";
    deletions.textContent = `-${formatCount(stats.deletions)}`;
    diffStats.append(deletions);
  }

  if (stats.additions > 0) {
    const additions = document.createElement("span");
    additions.className = "positive";
    additions.textContent = `+${formatCount(stats.additions)}`;
    diffStats.append(additions);
  }

  header.append(diffStats);

  if (section.loadState === "deferred") {
    const loadButton = document.createElement("button");
    loadButton.className = "delta-load-section-button";
    loadButton.type = "button";
    loadButton.title = `Load ${sectionLabel[section.kind].toLowerCase()} diff`;
    loadButton.ariaLabel = `Load diff for ${file.path}`;
    loadButton.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Load</span>`;
    loadButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onLoadSection(file, section);
    });
    header.append(loadButton);
  }

  return header;
}

function colorizeFileTreeStats(host: HTMLElement) {
  const container = host.querySelector("file-tree-container");
  const root = container?.shadowRoot;
  if (!root) return () => {};

  const enhance = () => {
    for (const stat of root.querySelectorAll<HTMLElement>(
      "[data-item-section='decoration'] > span",
    )) {
      const text = stat.textContent?.trim() ?? "";
      if (stat.dataset.deltaStatsEnhanced === text) continue;

      const match = text.match(/^(\+\S+)?(?:\s+(-\S+))?$/);
      if (!match || (!match[1] && !match[2])) continue;

      stat.replaceChildren();
      if (match[1]) {
        const additions = document.createElement("span");
        additions.className = "positive";
        additions.textContent = match[1];
        stat.append(additions);
      }
      if (match[2]) {
        if (match[1]) stat.append(document.createTextNode(" "));
        const deletions = document.createElement("span");
        deletions.className = "negative";
        deletions.textContent = match[2];
        stat.append(deletions);
      }
      stat.dataset.deltaStatsEnhanced = text;
    }
  };

  enhance();

  const observer = new MutationObserver(enhance);
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function FileTreePane(props: {
  files: ReadonlyArray<ChangedFile>;
  onSelectPath: (path: string) => void;
  searchQuery: string;
  selectedPath: string | null;
  treeFiles: ReadonlyArray<string>;
}) {
  let host: HTMLDivElement | undefined;
  let tree: FileTree | undefined;
  let suppressSelectionChange = false;

  const paths = createMemo(() => props.treeFiles);
  const gitStatus = createMemo(() =>
    props.files.map((file) => ({ path: file.path, status: statusForTree[file.status] })),
  );
  const changedFilesByPath = createMemo(
    () => new Map(props.files.map((file) => [file.path, file])),
  );

  onMount(() => {
    if (!host) return;

    tree = new FileTree({
      flattenEmptyDirectories: true,
      fileTreeSearchMode: "hide-non-matches",
      gitStatus: gitStatus(),
      icons: { colored: true, set: "complete" },
      initialExpansion: "open",
      initialSelectedPaths: props.selectedPath ? [props.selectedPath] : [],
      itemHeight: 28,
      onSelectionChange(selectedPaths) {
        if (suppressSelectionChange) return;
        const path = selectedPaths.at(-1);
        if (path) props.onSelectPath(path);
      },
      paths: paths(),
      renderRowDecoration({ row }): FileTreeRowDecoration | null {
        if (row.kind !== "file") return null;

        const file = changedFilesByPath().get(row.path);
        if (!file) return null;

        const text = formatFileStatsText(countFilePatchLines(file));
        if (!text) return null;

        return {
          text,
          title: `${file.path}: ${text}`,
        };
      },
      unsafeCSS: `
        :host {
          --trees-bg-override: transparent;
          --trees-fg-override: var(--sidebar-text);
          --trees-fg-muted-override: var(--muted);
          --trees-accent-override: #149dfb;
          --trees-selected-bg-override: rgb(20 157 251 / 0.1);
          --trees-selected-fg-override: var(--text);
          --trees-selected-focused-border-color-override: #149dfb;
          --trees-border-radius-override: 5px;
          --trees-font-family-override: var(--font-sans);
          --trees-font-size-override: 14px;
          --trees-font-weight-regular-override: 500;
          --trees-font-weight-semibold-override: 650;
          --trees-level-gap-override: 8px;
          --trees-item-padding-x-override: 6px;
          --trees-item-margin-x-override: 0px;
          --trees-item-row-gap-override: 6px;
          --trees-icon-width-override: 16px;
          --trees-padding-inline-override: 0px;
          --trees-scrollbar-gutter-override: 6px;
          color: var(--sidebar-text);
        }

        button[data-type='item'] {
          border: 1px solid transparent;
          border-radius: 5px;
          margin-inline: 0 2px;
        }

        button[data-type='item'][data-item-selected] {
          background: rgb(20 157 251 / 0.1);
          border-color: #149dfb;
        }

        button[data-type='item'][data-item-selected] [data-item-section='content'] {
          color: var(--text);
        }

        [data-item-section='spacing-item'] {
          opacity: 0.7;
        }

        [data-item-section='icon'] {
          align-items: center;
          color: var(--muted);
          display: inline-flex;
          opacity: 0.9;
        }

        button[data-type='item'][data-item-selected] [data-item-section='icon'] {
          color: var(--sidebar-text);
          opacity: 1;
        }

        [data-item-section='content'] {
          align-items: center;
          display: inline-flex;
          line-height: 1.25;
          min-width: 0;
        }

        [data-item-section='content'] [data-truncate-content] {
          line-height: inherit;
        }

        [data-item-section='decoration'] {
          align-items: center;
          color: var(--muted);
          flex: 0 0 54px;
          font-family: var(--font-mono);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          font-weight: 650;
          justify-content: flex-end;
          letter-spacing: 0;
          line-height: 1;
          min-width: 54px;
          padding-inline-start: 8px;
          transform: translateY(1px);
        }

        [data-item-section='decoration'] > span {
          align-items: center;
          display: inline-flex;
          gap: 6px;
          justify-content: flex-end;
          line-height: 1;
          width: 100%;
        }

        [data-item-section='decoration'] span span {
          align-items: center;
          display: inline-flex;
          line-height: 1;
        }

        [data-item-section='decoration'] .positive {
          color: var(--green);
        }

        [data-item-section='decoration'] .negative {
          color: var(--red);
        }

        [data-item-section='decoration'] .positive + .negative {
          margin-left: 6px;
        }

        [data-item-git-status='added'] > [data-item-section='decoration'],
        [data-item-git-status='untracked'] > [data-item-section='decoration'] {
          color: var(--green);
        }

        [data-item-git-status='deleted'] > [data-item-section='decoration'] {
          color: var(--red);
        }

        [data-item-type='folder'] [data-item-section='decoration'] {
          display: none;
        }

        [data-item-git-status] > [data-item-section='git'] {
          align-items: center;
          display: inline-flex;
          flex: 0 0 18px;
          font-size: 13px;
          justify-content: flex-end;
          line-height: 1;
          width: 18px;
        }
      `,
    });
    tree.render({ containerWrapper: host });
    const stopColorizingStats = colorizeFileTreeStats(host);
    onCleanup(stopColorizingStats);
  });

  createEffect(() => {
    if (!tree) return;
    tree.resetPaths(paths());
    tree.setGitStatus(gitStatus());
  });

  createEffect(() => {
    if (!tree) return;
    const query = props.searchQuery.trim();
    tree.setSearch(query.length > 0 ? query : null);
  });

  createEffect(() => {
    if (!tree || !props.selectedPath) return;

    const current = tree.getSelectedPaths();
    if (current.length === 1 && current[0] === props.selectedPath) return;

    suppressSelectionChange = true;
    for (const path of current) {
      tree.getItem(path)?.deselect();
    }
    tree.getItem(props.selectedPath)?.select();
    tree.focusPath(props.selectedPath);
    window.setTimeout(() => {
      suppressSelectionChange = false;
    }, 0);
  });

  onCleanup(() => tree?.cleanUp());

  return (
    <div
      class="file-tree-host"
      ref={(element) => {
        host = element;
      }}
    />
  );
}

function PreferenceSwitch(props: {
  checked: boolean;
  icon: typeof PaintBucket;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const Icon = props.icon;

  return (
    <label class="diff-settings-row">
      <span class="diff-settings-label">
        <Icon size={15} aria-hidden />
        <span>{props.label}</span>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function BrowserBar(props: {
  onOpenRepository: (target: OpenRepositoryTarget) => void;
  onToggleDiffStyle: () => void;
  onUpdatePreferences: (preferences: Partial<DiffViewPreferences>) => void;
  preferences: DiffViewPreferences;
  root: string | undefined;
}) {
  let settingsButton: HTMLButtonElement | undefined;
  let settingsPopover: HTMLDivElement | undefined;
  const label = createMemo(() => repositoryName(props.root));
  const isDesktopShell = typeof window !== "undefined" && "__electrobun" in window;
  const actionDisabled = () => !props.root;
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const diffStyleLabel = createMemo(() =>
    props.preferences.diffStyle === "split" ? "Split view" : "Unified view",
  );

  createEffect(() => {
    if (!settingsOpen()) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (settingsButton?.contains(target) || settingsPopover?.contains(target)) return;
      setSettingsOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
  });

  function closeSettings() {
    setSettingsOpen(false);
    settingsButton?.focus();
  }

  return (
    <header class="browser-bar" classList={{ "desktop-window-chrome": isDesktopShell }}>
      <div class="browser-location">
        {/* Kept in markup so the Delta mark can be restored without rebuilding the titlebar. */}
        <svg class="app-mark" viewBox="0 0 32 32" aria-hidden>
          <path d="M16 5 29 27H3L16 5Z" fill="currentColor" />
          <path d="M16 14 22 24H10L16 14Z" fill="var(--browser-bg)" />
        </svg>
        <span title={props.root ?? "Loading repository"}>{label()}</span>
      </div>
      <div class="browser-review-shortcuts" aria-label="Review keyboard shortcuts">
        <span class="browser-shortcut-item">
          Previous
          <KbdShortcut keys={[","]} size="sm" variant="outline" />
        </span>
        <span class="browser-shortcut-item">
          Next
          <KbdShortcut keys={["."]} size="sm" variant="outline" />
        </span>
        <span class="browser-shortcut-item">
          Viewed
          <KbdShortcut keys={["V"]} size="sm" variant="outline" />
        </span>
        <span class="browser-shortcut-item">
          Collapse
          <KbdShortcut keys={["C"]} size="sm" variant="outline" />
        </span>
      </div>
      <div class="browser-tools" aria-label="View controls">
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Finder` : "Open in Finder"}
          aria-label="Open repository in Finder"
          disabled={actionDisabled()}
          onClick={() => props.onOpenRepository("finder")}
        >
          <img class="app-action-icon" src="/app-icons/finder.png" alt="" aria-hidden />
        </button>
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Zed` : "Open in Zed"}
          aria-label="Open repository in Zed"
          disabled={actionDisabled()}
          onClick={() => props.onOpenRepository("zed")}
        >
          <img class="app-action-icon" src="/app-icons/zed.png" alt="" aria-hidden />
        </button>
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Ghostty` : "Open in Ghostty"}
          aria-label="Open repository in Ghostty"
          disabled={actionDisabled()}
          onClick={() => props.onOpenRepository("ghostty")}
        >
          <img class="app-action-icon" src="/app-icons/ghostty.png" alt="" aria-hidden />
        </button>
        <span class="browser-toolbar-spacer" aria-hidden="true" />
        <button
          class="bar-icon-button"
          type="button"
          title={`Switch to ${props.preferences.diffStyle === "split" ? "unified" : "split"} view`}
          aria-label={diffStyleLabel()}
          aria-pressed={props.preferences.diffStyle === "split"}
          onClick={props.onToggleDiffStyle}
        >
          <Show
            when={props.preferences.diffStyle === "split"}
            fallback={<AlignJustify size={17} aria-hidden />}
          >
            <SplitSquareVertical size={17} aria-hidden />
          </Show>
        </button>
        <div class="diff-settings-anchor">
          <button
            ref={(element) => {
              settingsButton = element;
            }}
            class="bar-icon-button"
            classList={{ active: settingsOpen() }}
            type="button"
            title="Diff display settings"
            aria-label="Diff display settings"
            aria-expanded={settingsOpen()}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={18} aria-hidden />
          </button>
          <Show when={settingsOpen()}>
            <div
              ref={(element) => {
                settingsPopover = element;
              }}
              class="diff-settings-popover"
              role="dialog"
              aria-label="Diff display settings"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                closeSettings();
              }}
            >
              <PreferenceSwitch
                checked={props.preferences.backgrounds}
                icon={PaintBucket}
                label="Backgrounds"
                onChange={(backgrounds) => props.onUpdatePreferences({ backgrounds })}
              />
              <PreferenceSwitch
                checked={props.preferences.lineNumbers}
                icon={ListOrdered}
                label="Line numbers"
                onChange={(lineNumbers) => props.onUpdatePreferences({ lineNumbers })}
              />
              <PreferenceSwitch
                checked={props.preferences.wordWrap}
                icon={WrapText}
                label="Word wrap"
                onChange={(wordWrap) => props.onUpdatePreferences({ wordWrap })}
              />
            </div>
          </Show>
        </div>
      </div>
    </header>
  );
}

function SelectedFileStats(props: { file: ChangedFile | undefined }) {
  const stats = createMemo(() => (props.file ? countFilePatchLines(props.file) : null));

  return (
    <div class="selected-file-stats" aria-live="polite">
      <div class="selected-file-stats-path" title={props.file?.path ?? "No changed file selected"}>
        {props.file?.path ?? "No changed file selected"}
      </div>
      <div class="selected-file-stats-counts" aria-label="Selected file line changes">
        <span class="positive">+{formatCount(stats()?.additions ?? 0)}</span>
        <span class="negative">-{formatCount(stats()?.deletions ?? 0)}</span>
      </div>
    </div>
  );
}

function DiffCodeView(props: {
  collapsed: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  preferences: DiffViewPreferences;
  previewFile: RepositoryFile | null;
  scrollTarget: ScrollTarget | null;
  viewed: Record<string, string>;
}) {
  let host: HTMLDivElement | undefined;
  let codeView: CodeView | undefined;
  let navigationCorrectionId = 0;
  let stopScrollPerfBenchmark: (() => void) | undefined;
  let scrollPerfBenchmarkStarted = false;
  let pendingHeaderAnchor:
    | {
        itemId: string;
        offset: number;
        path: string;
      }
    | undefined;
  const [codeViewReady, setCodeViewReady] = createSignal(false);

  const buildItems = createMemo(() =>
    buildCodeViewItemModel({
      collapsed: props.collapsed,
      files: props.files,
      previewFile: props.previewFile,
      viewed: props.viewed,
    }),
  );
  function firstItemIdForPath(path: string) {
    const file = props.files.find((candidate) => candidate.path === path);
    const section = file?.sections[0];
    return section ? diffItemId(section) : undefined;
  }

  function captureHeaderAnchor(itemId: string, path: string) {
    if (!codeView) return;

    const itemTop = codeView.getTopForItem(itemId);
    if (itemTop == null) return;

    pendingHeaderAnchor = {
      itemId,
      offset: itemTop - codeView.getScrollTop(),
      path,
    };
  }

  function restoreHeaderAnchor() {
    const anchor = pendingHeaderAnchor;
    if (!anchor || !codeView) return;

    pendingHeaderAnchor = undefined;
    codeView.render(true);

    const itemTop =
      codeView.getTopForItem(anchor.itemId) ??
      (firstItemIdForPath(anchor.path)
        ? codeView.getTopForItem(firstItemIdForPath(anchor.path)!)
        : undefined);

    if (itemTop == null) return;

    codeView.scrollTo({
      behavior: "instant",
      position: Math.max(0, itemTop - anchor.offset),
      type: "position",
    });
    codeView.render(true);
  }

  function measureFileHeaderTop(itemId: string) {
    if (!codeView) return;

    const renderedItem = codeView.getRenderedItems().find((item) => item.id === itemId);
    const container = codeView.getContainerElement() ?? host;
    const header =
      renderedItem?.element.querySelector<HTMLElement>(".delta-file-header") ??
      renderedItem?.element;
    if (!header || !container) return;

    return header.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }

  function scrollToActualTop(position: number, behavior: "instant" | "smooth" = "instant") {
    if (!codeView) return;

    codeView.scrollTo({
      behavior,
      position: position + (props.previewFile ? 0 : codeViewItemMetrics.diffHeaderHeight),
      type: "position",
    });
  }

  function correctFileHeaderScroll(itemId: string, correctionId: number, attempt = 0) {
    if (!codeView || correctionId !== navigationCorrectionId) return;

    codeView.render(true);

    const headerTop = measureFileHeaderTop(itemId);
    if (headerTop == null) {
      if (attempt < 6) {
        window.requestAnimationFrame(() =>
          correctFileHeaderScroll(itemId, correctionId, attempt + 1),
        );
      }
      return;
    }

    if (Math.abs(headerTop) <= 1) return;

    scrollToActualTop(codeView.getScrollTop() + headerTop);

    if (attempt < 3) {
      window.requestAnimationFrame(() =>
        correctFileHeaderScroll(itemId, correctionId, attempt + 1),
      );
    }
  }

  function finishFileHeaderScroll(
    itemId: string,
    correctionId: number,
    previousScrollTop: number | undefined = undefined,
    stableFrames = 0,
    attempt = 0,
  ) {
    if (!codeView || correctionId !== navigationCorrectionId) return;

    const currentScrollTop = codeView.getScrollTop();
    const nextStableFrames =
      previousScrollTop != null && Math.abs(currentScrollTop - previousScrollTop) <= 0.5
        ? stableFrames + 1
        : 0;

    if (nextStableFrames >= 2 || attempt >= 90) {
      correctFileHeaderScroll(itemId, correctionId);
      return;
    }

    window.requestAnimationFrame(() =>
      finishFileHeaderScroll(itemId, correctionId, currentScrollTop, nextStableFrames, attempt + 1),
    );
  }

  function guideSmoothFileHeaderScroll(itemId: string, correctionId: number, attempt = 0) {
    if (!codeView || correctionId !== navigationCorrectionId) return;

    codeView.render(true);

    const headerTop = measureFileHeaderTop(itemId);
    if (headerTop == null) {
      if (attempt < 30) {
        window.requestAnimationFrame(() =>
          guideSmoothFileHeaderScroll(itemId, correctionId, attempt + 1),
        );
      }
      return;
    }

    if (Math.abs(headerTop) > 1) {
      scrollToActualTop(codeView.getScrollTop() + headerTop, "smooth");
    }

    finishFileHeaderScroll(itemId, correctionId);
  }

  const options = createMemo(
    () =>
      ({
        diffIndicators: "bars",
        diffStyle: props.preferences.diffStyle,
        disableBackground: !props.preferences.backgrounds,
        disableFileHeader: Boolean(props.previewFile),
        disableLineNumbers: !props.preferences.lineNumbers,
        enableLineSelection: true,
        hunkSeparators: "simple",
        itemMetrics: codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: "word-alt",
        maxLineDiffLength: 800,
        overflow: props.preferences.wordWrap ? "wrap" : "scroll",
        renderCustomHeader: (_fileDiff, context) => {
          const metadata = buildItems().itemMetadata.get(context.item.id);
          if (!metadata) return undefined;
          return createFileHeader({
            ...metadata,
            onToggleCollapsed: (file, isCollapsed) => {
              captureHeaderAnchor(context.item.id, file.path);
              props.onToggleCollapsed(file, isCollapsed);
            },
            onLoadSection: (file, section) => {
              captureHeaderAnchor(context.item.id, file.path);
              props.onLoadSection(file, section);
            },
          });
        },
        smoothScrollSettings: codeViewSmoothScrollSettings,
        stickyHeaders: true,
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType: "system",
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<undefined>,
  );

  onMount(() => {
    if (!host) return;

    codeView = new CodeView(options());
    codeView.config.overscrollSize = codeViewScrollOverscan;
    codeView.setup(host);
    setCodeViewReady(true);
  });

  createEffect(() => {
    if (!codeViewReady() || !codeView) return;
    codeView.setOptions(options());
  });

  createEffect(() => {
    if (!codeViewReady() || !codeView) return;
    codeView.setItems(buildItems().items);
    restoreHeaderAnchor();
  });

  createEffect(() => {
    if (!codeViewReady() || !host || scrollPerfBenchmarkStarted) return;
    if (!shouldRunScrollPerfBenchmark() || buildItems().items.length === 0) return;

    scrollPerfBenchmarkStarted = true;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (host) stopScrollPerfBenchmark = runScrollPerfBenchmark(host);
      });
    });
  });

  createEffect(() => {
    if (!codeView || !props.scrollTarget) return;
    const correctionId = ++navigationCorrectionId;
    const itemId = buildItems().fileStartItemIdByPath.get(props.scrollTarget.path);
    if (!itemId) return;

    const itemTop = codeView.getTopForItem(itemId);
    if (itemTop != null) {
      scrollToActualTop(itemTop, "smooth");
      window.requestAnimationFrame(() => guideSmoothFileHeaderScroll(itemId, correctionId));
      return;
    }

    codeView.scrollTo({ align: "start", behavior: "smooth", id: itemId, type: "item" });
    window.requestAnimationFrame(() => guideSmoothFileHeaderScroll(itemId, correctionId));
  });

  onCleanup(() => {
    stopScrollPerfBenchmark?.();
    codeView?.cleanUp();
  });

  return (
    <div
      class="code-view-host"
      classList={{ "file-preview-mode": Boolean(props.previewFile) }}
      ref={(element) => {
        host = element;
      }}
    />
  );
}

function DeltaApp() {
  let fileSearchInput: HTMLInputElement | undefined;
  const [fileSearchQuery, setFileSearchQuery] = createSignal("");
  const [fileSearchOpen, setFileSearchOpen] = createSignal(false);
  const [preferences, setPreferences] =
    createSignal<DiffViewPreferences>(readDiffViewPreferences());
  const workspace = createReviewWorkspace({
    countFilePatchLines,
    readViewed,
    writeViewed,
  });
  const {
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
    state,
    switchSidebarFileMode,
    loadDiffSection,
    toggleCollapsed,
    toggleSelectedFileCollapsed,
    toggleSelectedFileViewed,
    toggleViewed,
    viewed,
  } = workspace;
  const visibleTreeFiles = createMemo(() => {
    const query = fileSearchQuery().trim().toLowerCase();
    if (!query) return sidebarTreeFiles();
    return sidebarTreeFiles().filter((path) => path.toLowerCase().includes(query));
  });

  function updatePreferences(patch: Partial<DiffViewPreferences>) {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      writeDiffViewPreferences(next);
      return next;
    });
  }

  function toggleDiffStyle() {
    updatePreferences({
      diffStyle: preferences().diffStyle === "split" ? "unified" : "split",
    });
  }

  const runReviewShortcut = (event: KeyboardEvent, action: () => void) => {
    if (isEditableShortcutTarget(event.target)) return;
    action();
  };

  createHotkey(
    ".",
    (event) => runReviewShortcut(event, () => moveSelectedFile(1)),
    () => ({ enabled: files().length > 0, ignoreInputs: true }),
  );
  createHotkey(
    ",",
    (event) => runReviewShortcut(event, () => moveSelectedFile(-1)),
    () => ({ enabled: files().length > 0, ignoreInputs: true }),
  );
  createHotkey(
    "V",
    (event) => runReviewShortcut(event, toggleSelectedFileViewed),
    () => ({ enabled: Boolean(selectedChangedFile()), ignoreInputs: true }),
  );
  createHotkey(
    "C",
    (event) => runReviewShortcut(event, toggleSelectedFileCollapsed),
    () => ({ enabled: Boolean(selectedChangedFile()), ignoreInputs: true }),
  );
  createHotkey(
    "R",
    (event) => runReviewShortcut(event, () => void refresh()),
    () => ({ enabled: true, ignoreInputs: true }),
  );

  createEffect(() => {
    if (!fileSearchOpen()) return;
    queueMicrotask(() => fileSearchInput?.focus());
  });

  function closeFileSearch() {
    setFileSearchOpen(false);
    setFileSearchQuery("");
  }

  return (
    <main class="delta-shell">
      <BrowserBar
        preferences={preferences()}
        root={state()?.root}
        onOpenRepository={openRepository}
        onToggleDiffStyle={toggleDiffStyle}
        onUpdatePreferences={updatePreferences}
      />
      <div class="delta-app">
        <aside class="sidebar-shell">
          <div class="sidebar-chrome">
            <div class="sidebar-mode-switch" role="tablist" aria-label="File tree scope">
              <button
                class="sidebar-mode-button"
                classList={{ active: sidebarFileMode() === "all" }}
                type="button"
                role="tab"
                aria-selected={sidebarFileMode() === "all"}
                title={state()?.root ? compactPath(state()!.root) : "All files"}
                onClick={() => switchSidebarFileMode("all")}
              >
                All files
              </button>
              <button
                class="sidebar-mode-button"
                classList={{ active: sidebarFileMode() === "changed" }}
                type="button"
                role="tab"
                aria-selected={sidebarFileMode() === "changed"}
                onClick={() => switchSidebarFileMode("changed")}
              >
                Changed
              </button>
            </div>
            <button
              class="sidebar-tool-button"
              classList={{ active: fileSearchOpen() }}
              type="button"
              title="Search files"
              aria-label="Search files"
              aria-expanded={fileSearchOpen()}
              aria-controls="sidebar-file-search"
              onClick={() => setFileSearchOpen((open) => !open)}
            >
              <Search size={20} aria-hidden />
            </button>
          </div>

          <Show when={fileSearchOpen()}>
            <div class="sidebar-search-popdown" id="sidebar-file-search">
              <Search size={15} aria-hidden />
              <input
                ref={(element) => {
                  fileSearchInput = element;
                }}
                type="search"
                value={fileSearchQuery()}
                placeholder="Search files"
                aria-label="Search files"
                onInput={(event) => setFileSearchQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  closeFileSearch();
                }}
              />
            </div>
          </Show>

          <div class="sidebar-tree-region">
            <Show
              when={visibleTreeFiles().length > 0}
              fallback={
                <div class="sidebar-empty">
                  <Show when={fileSearchQuery().trim()} fallback={<Check size={16} aria-hidden />}>
                    <Search size={16} aria-hidden />
                  </Show>
                  <Show
                    when={fileSearchQuery().trim()}
                    fallback={
                      sidebarFileMode() === "changed" ? "No changed files" : "No repository files"
                    }
                  >
                    No matching files
                  </Show>
                </div>
              }
            >
              <FileTreePane
                files={files()}
                onSelectPath={selectPath}
                searchQuery={fileSearchQuery()}
                selectedPath={selectedPath()}
                treeFiles={visibleTreeFiles()}
              />
            </Show>
          </div>

          <SelectedFileStats file={selectedChangedFile()} />

          <div class="diff-stats-panel">
            <dl class="diff-stats-list">
              <div>
                <dt>Files</dt>
                <dd>{formatCount(diffStats().files)}</dd>
              </div>
              <div>
                <dt>Additions</dt>
                <dd class="positive">{formatCount(diffStats().additions)}</dd>
              </div>
              <div>
                <dt>Deletions</dt>
                <dd class="negative">{formatCount(diffStats().deletions)}</dd>
              </div>
            </dl>
          </div>
        </aside>

        <section class="review-shell">
          <Show when={error()}>
            {(message) => (
              <div class="state-panel">
                <strong>Unable to read repository</strong>
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <Show
            when={
              !error() &&
              state() &&
              files().length === 0 &&
              !previewFile() &&
              !previewLoading() &&
              !previewError()
            }
          >
            <div class="state-panel">
              <Check size={18} aria-hidden />
              <strong>No local changes</strong>
              <span>{state()?.root}</span>
            </div>
          </Show>

          <Show when={!error() && previewLoading()}>
            <div class="state-panel">
              <RefreshCcw size={18} class="spin" aria-hidden />
              <strong>Loading file</strong>
              <span>{selectedPath()}</span>
            </div>
          </Show>

          <Show when={!error() && previewError()}>
            {(message) => (
              <div class="state-panel">
                <strong>Unable to read file</strong>
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <Show
            when={
              !error() &&
              state() &&
              !previewLoading() &&
              !previewError() &&
              (files().length > 0 || previewFile())
            }
          >
            <DiffCodeView
              collapsed={collapsed()}
              files={files()}
              onToggleCollapsed={toggleCollapsed}
              onLoadSection={loadDiffSection}
              onToggleViewed={toggleViewed}
              preferences={preferences()}
              previewFile={previewFile()}
              scrollTarget={scrollTarget()}
              viewed={viewed()}
            />
          </Show>

          <Show when={!error() && !state()}>
            <div class="state-panel">
              <RefreshCcw size={18} class="spin" aria-hidden />
              <strong>Loading repository</strong>
            </div>
          </Show>
        </section>
      </div>
    </main>
  );
}
