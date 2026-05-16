import {
  CodeView,
  DEFAULT_CODE_VIEW_FILE_METRICS,
  DEFAULT_CODE_VIEW_LAYOUT,
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewOptions,
  type CodeViewScrollTarget,
  type FileDiffMetadata,
  type SelectionSide,
  type SmoothScrollSettings,
} from "@pierre/diffs";
import { FileTree, type GitStatusEntry } from "@pierre/trees";
import { createFileRoute } from "@tanstack/solid-router";
import {
  Check,
  GitBranch,
  MessageCircle,
  RefreshCcw,
  Search,
  Settings,
  SplitSquareVertical,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";

import { deltaClient } from "@/lib/delta-client";
import type { ChangedFile, DiffSection, GitFileStatus, RepositoryState } from "@/lib/repository";

export const Route = createFileRoute("/")({
  component: DeltaApp,
});

type ScrollTarget = {
  path: string;
  request: number;
};

type DiffScrollTarget = Extract<CodeViewScrollTarget, { type: "item" | "line" }>;

const sectionLabel: Record<DiffSection["kind"], string> = {
  commit: "Commit",
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
  diffHeaderHeight: 48,
  lineHeight: 23,
};

const codeViewSmoothScrollSettings = {
  omega: 0.018,
  positionEpsilon: 0.5,
  velocityEpsilon: 0.05,
} satisfies SmoothScrollSettings;

const codeViewScrollOverscan = 8_000;

const parsedSectionDiffs = new WeakMap<DiffSection, FileDiffMetadata>();
const patchLineCounts = new WeakMap<DiffSection, { additions: number; deletions: number }>();

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
    min-height: 48px;
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

  const counts = countPatchLines(section.patch);
  patchLineCounts.set(section, counts);
  return counts;
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

function itemId(section: DiffSection) {
  return `diff:${section.id}`;
}

function firstChangedLineTarget(id: string, fileDiff: FileDiffMetadata): DiffScrollTarget {
  const firstHunk = fileDiff.hunks[0];
  if (!firstHunk) return { behavior: "smooth", id, type: "item" };

  const side: SelectionSide = firstHunk.additionCount > 0 ? "additions" : "deletions";
  return {
    align: "start",
    behavior: "smooth",
    id,
    lineNumber: side === "additions" ? firstHunk.additionStart : firstHunk.deletionStart,
    offset: 8,
    side,
    type: "line",
  };
}

function createBinaryFileDiff(file: ChangedFile, section: DiffSection): FileDiffMetadata {
  return {
    additionLines: ["Binary file changed\n"],
    cacheKey: `binary:${file.fingerprint}:${section.id}`,
    deletionLines: [],
    hunks: [
      {
        additionCount: 1,
        additionLineIndex: 0,
        additionLines: 1,
        additionStart: 1,
        collapsedBefore: 0,
        deletionCount: 0,
        deletionLineIndex: 0,
        deletionLines: 0,
        deletionStart: 0,
        hunkContent: [
          {
            additionLineIndex: 0,
            additions: 1,
            deletionLineIndex: 0,
            deletions: 0,
            type: "change",
          },
        ],
        hunkSpecs: "@@ -0,0 +1 @@\n",
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
        splitLineCount: 1,
        splitLineStart: 0,
        unifiedLineCount: 1,
        unifiedLineStart: 0,
      },
    ],
    isPartial: true,
    name: file.path,
    prevName: file.oldPath,
    splitLineCount: 1,
    type: file.status === "deleted" ? "deleted" : file.status === "added" ? "new" : "change",
    unifiedLineCount: 1,
  };
}

function parseSectionDiff(file: ChangedFile, section: DiffSection): FileDiffMetadata {
  const cached = parsedSectionDiffs.get(section);
  if (cached) return cached;

  let parsedDiff: FileDiffMetadata;
  if (section.binary) {
    parsedDiff = createBinaryFileDiff(file, section);
    parsedSectionDiffs.set(section, parsedDiff);
    return parsedDiff;
  }

  const parsedFile = parsePatchFiles(section.patch, section.id)[0]?.files[0];
  if (!parsedFile) {
    parsedDiff = createBinaryFileDiff(file, section);
    parsedSectionDiffs.set(section, parsedDiff);
    return parsedDiff;
  }

  parsedDiff = { ...parsedFile, cacheKey: `${file.fingerprint}:${section.id}` };
  parsedSectionDiffs.set(section, parsedDiff);
  return parsedDiff;
}

function createFileHeader({
  file,
  isCollapsed,
  isViewed,
  onToggleCollapsed,
  section,
  sectionCount,
}: {
  file: ChangedFile;
  isCollapsed: boolean;
  isViewed: boolean;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
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
  path.innerHTML = '<span aria-hidden class="delta-file-icon"></span>';
  path.append(document.createTextNode(file.path));
  heading.append(path);

  if (file.oldPath) {
    const oldPath = document.createElement("div");
    oldPath.className = "delta-file-old-path";
    oldPath.textContent = file.oldPath;
    heading.append(oldPath);
  }

  header.append(toggle, heading);

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

  return header;
}

function FileTreePane(props: {
  files: ReadonlyArray<ChangedFile>;
  onSelectPath: (path: string) => void;
  selectedPath: string | null;
}) {
  let host: HTMLDivElement | undefined;
  let tree: FileTree | undefined;
  let suppressSelectionChange = false;

  const paths = createMemo(() => props.files.map((file) => file.path));
  const gitStatus = createMemo(() =>
    props.files.map((file) => ({ path: file.path, status: statusForTree[file.status] })),
  );

  onMount(() => {
    if (!host) return;

    tree = new FileTree({
      flattenEmptyDirectories: true,
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
          color: var(--muted);
          opacity: 0.9;
        }

        button[data-type='item'][data-item-selected] [data-item-section='icon'] {
          color: var(--sidebar-text);
          opacity: 1;
        }

        [data-item-section='content'] {
          min-width: 0;
        }

        [data-item-git-status] > [data-item-section='git'] {
          font-size: 13px;
        }
      `,
    });
    tree.render({ containerWrapper: host });
  });

  createEffect(() => {
    if (!tree) return;
    tree.resetPaths(paths());
    tree.setGitStatus(gitStatus());
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

function BrowserBar(props: { onOpenRepository: () => void; root: string | undefined }) {
  const label = createMemo(() => repositoryName(props.root));
  const isDesktopShell = typeof window !== "undefined" && "__electrobun" in window;
  const actionDisabled = () => !props.root;

  return (
    <header class="browser-bar" classList={{ "desktop-window-chrome": isDesktopShell }}>
      <div class="browser-location">
        <svg class="app-mark" viewBox="0 0 32 32" aria-hidden>
          <path d="M16 5 29 27H3L16 5Z" fill="currentColor" />
          <path d="M16 14 22 24H10L16 14Z" fill="var(--browser-bg)" />
        </svg>
        <span title={props.root ?? "Loading repository"}>{label()}</span>
      </div>
      <div class="browser-tools" aria-label="View controls">
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Finder` : "Open in Finder"}
          aria-label="Open repository in Finder"
          disabled={actionDisabled()}
          onClick={props.onOpenRepository}
        >
          <img class="app-action-icon" src="/app-icons/finder.png" alt="" aria-hidden />
        </button>
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Zed` : "Open in Zed"}
          aria-label="Open repository in Zed"
          disabled={actionDisabled()}
          onClick={() => {
            const root = props.root;
            if (root) void deltaClient.openRepository(root, "zed");
          }}
        >
          <img class="app-action-icon" src="/app-icons/zed.png" alt="" aria-hidden />
        </button>
        <button
          class="bar-icon-button"
          type="button"
          title={props.root ? `Open ${props.root} in Ghostty` : "Open in Ghostty"}
          aria-label="Open repository in Ghostty"
          disabled={actionDisabled()}
          onClick={() => {
            const root = props.root;
            if (root) void deltaClient.openRepository(root, "ghostty");
          }}
        >
          <img class="app-action-icon" src="/app-icons/ghostty.png" alt="" aria-hidden />
        </button>
        <button class="bar-icon-button" type="button" title="Split view">
          <SplitSquareVertical size={17} aria-hidden />
        </button>
        <button class="bar-icon-button" type="button" title="Settings">
          <Settings size={18} aria-hidden />
        </button>
      </div>
    </header>
  );
}

function DiffCodeView(props: {
  collapsed: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  scrollTarget: ScrollTarget | null;
  viewed: Record<string, string>;
}) {
  let host: HTMLDivElement | undefined;
  let codeView: CodeView | undefined;
  const [codeViewReady, setCodeViewReady] = createSignal(false);

  const buildItems = createMemo(() => {
    const items: CodeViewItem[] = [];
    const firstScrollTargetByPath = new Map<string, DiffScrollTarget>();
    const itemMetadata = new Map<
      string,
      {
        file: ChangedFile;
        isCollapsed: boolean;
        isViewed: boolean;
        section: DiffSection;
        sectionCount: number;
      }
    >();

    for (const file of props.files) {
      const isViewed = props.viewed[file.path] === file.fingerprint;
      const isCollapsed = props.collapsed.has(file.path) || isViewed;
      const sections = isCollapsed ? file.sections.slice(0, 1) : file.sections;

      for (const [index, section] of sections.entries()) {
        const id = itemId(section);
        const fileDiff = parseSectionDiff(file, section);
        itemMetadata.set(id, {
          file,
          isCollapsed,
          isViewed,
          section,
          sectionCount: file.sections.length,
        });
        firstScrollTargetByPath.set(
          file.path,
          firstScrollTargetByPath.get(file.path) ?? firstChangedLineTarget(id, fileDiff),
        );
        items.push({
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: "diff",
          version: `${file.fingerprint}:${section.id}:${isCollapsed ? "closed" : "open"}:${isViewed ? "viewed" : "pending"}:${index}`,
        });
      }
    }

    return { firstScrollTargetByPath, itemMetadata, items };
  });

  const options = createMemo(
    () =>
      ({
        diffIndicators: "bars",
        diffStyle: "split",
        enableLineSelection: true,
        hunkSeparators: "simple",
        itemMetrics: codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: "char",
        renderCustomHeader: (_fileDiff, context) => {
          const metadata = buildItems().itemMetadata.get(context.item.id);
          if (!metadata) return undefined;
          return createFileHeader({
            ...metadata,
            onToggleCollapsed: props.onToggleCollapsed,
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
  });

  createEffect(() => {
    if (!codeView || !props.scrollTarget) return;
    const target = buildItems().firstScrollTargetByPath.get(props.scrollTarget.path);
    if (!target) return;

    codeView.scrollTo(target);
  });

  onCleanup(() => codeView?.cleanUp());

  return (
    <div
      class="code-view-host"
      ref={(element) => {
        host = element;
      }}
    />
  );
}

function DeltaApp() {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const [scrollTarget, setScrollTarget] = createSignal<ScrollTarget | null>(null);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [state, setState] = createSignal<RepositoryState | null>(null);
  const [viewed, setViewed] = createSignal<Record<string, string>>({});

  const files = createMemo(() => state()?.files ?? []);
  const diffStats = createMemo(() => {
    let additions = 0;
    let deletions = 0;

    for (const file of files()) {
      for (const section of file.sections) {
        const counts = countSectionPatchLines(section);
        additions += counts.additions;
        deletions += counts.deletions;
      }
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
      setViewed(readViewed(nextState.root));
      setSelectedPath((current) => current ?? nextState.files[0]?.path ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  onMount(() => {
    void refresh();
  });

  function selectPath(path: string) {
    setSelectedPath(path);
    setScrollTarget((current) => ({ path, request: (current?.request ?? 0) + 1 }));
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
      writeViewed(root, next);
      return next;
    });

    setCollapsed((current) => {
      const next = new Set(current);
      if (isViewed) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }

  return (
    <main class="delta-shell">
      <BrowserBar
        root={state()?.root}
        onOpenRepository={() => {
          const root = state()?.root;
          if (root) void deltaClient.openRepository(root, "finder");
        }}
      />
      <div class="delta-app">
        <aside class="sidebar-shell">
          <div class="sidebar-chrome">
            <div class="sidebar-chrome-group">
              <button
                class="sidebar-tool-button active"
                type="button"
                title={state()?.root ? compactPath(state()!.root) : "Files"}
              >
                <GitBranch size={18} aria-hidden />
              </button>
              <button class="sidebar-tool-button" type="button" title="Comments">
                <MessageCircle size={19} aria-hidden />
              </button>
            </div>
            <button class="sidebar-tool-button" type="button" title="Search files">
              <Search size={20} aria-hidden />
            </button>
          </div>

          <div class="sidebar-tree-region">
            <Show
              when={files().length > 0}
              fallback={
                <div class="sidebar-empty">
                  <Check size={16} aria-hidden />
                  No local changes
                </div>
              }
            >
              <FileTreePane
                files={files()}
                onSelectPath={selectPath}
                selectedPath={selectedPath()}
              />
            </Show>
          </div>

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

          <Show when={!error() && state() && files().length === 0}>
            <div class="state-panel">
              <Check size={18} aria-hidden />
              <strong>No local changes</strong>
              <span>{state()?.root}</span>
            </div>
          </Show>

          <Show when={!error() && state() && files().length > 0}>
            <DiffCodeView
              collapsed={collapsed()}
              files={files()}
              onToggleCollapsed={toggleCollapsed}
              onToggleViewed={toggleViewed}
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
