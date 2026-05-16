import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ChangedFile,
  DiffSection,
  GitFileStatus,
  HistoryEntry,
  OpenRepositoryTarget,
  RepositoryFile,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from "../../../web/src/lib/repository";

const execFileAsync = promisify(execFile);

type StatusItem = {
  oldPath?: string;
  path: string;
  staged: boolean;
  status: GitFileStatus;
  unstaged: boolean;
  untracked: boolean;
};

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function execGit(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
}

async function execGitBuffer(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout as Buffer;
}

function fingerprintBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function resolveRepositoryPath(repoRoot: string, path: string) {
  if (!path || path.includes("\0")) {
    throw new Error("Invalid repository file path.");
  }

  const absolutePath = resolve(repoRoot, path);
  const rootPrefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;

  if (absolutePath !== repoRoot && !absolutePath.startsWith(rootPrefix)) {
    throw new Error("Repository file path escapes the repository root.");
  }

  return absolutePath;
}

function normalizeStatus(statusCode: string | undefined): GitFileStatus {
  if (statusCode === "A") return "added";
  if (statusCode === "D") return "deleted";
  if (statusCode === "R" || statusCode === "C") return "renamed";
  return "modified";
}

function parseStatus(raw: string): StatusItem[] {
  const parts = raw.split("\0").filter(Boolean);
  const files = new Map<string, StatusItem>();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;

    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    let path = record.slice(3);
    let oldPath: string | undefined;

    if (x === "R" || x === "C") {
      oldPath = parts[++index] ?? path;
    }

    const current =
      files.get(path) ??
      ({
        oldPath,
        path,
        staged: false,
        status: "modified",
        unstaged: false,
        untracked: false,
      } satisfies StatusItem);

    if (x === "?" && y === "?") {
      current.status = "untracked";
      current.unstaged = true;
      current.untracked = true;
    } else {
      current.staged = x !== " ";
      current.unstaged = y !== " ";
      current.status = normalizeStatus(current.staged ? x : y);
    }

    files.set(path, current);
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function parseNullSeparatedPaths(raw: string) {
  return raw
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function listWorkingTreeFiles(repoRoot: string, status: ReadonlyArray<StatusItem>) {
  const paths = new Set(
    parseNullSeparatedPaths(
      await execGit(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    ),
  );

  for (const item of status) {
    paths.add(item.path);
    if (item.oldPath) paths.add(item.oldPath);
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function listCommitTreeFiles(repoRoot: string, commit: string) {
  return parseNullSeparatedPaths(
    await execGit(repoRoot, ["ls-tree", "-r", "-z", "--name-only", commit]),
  );
}

function isBinaryBuffer(buffer: Buffer) {
  return buffer.includes(0);
}

class GitRepositoryAdapter {
  private constructor(private readonly repoRoot: string) {}

  static async fromLaunchPath(launchPath: string) {
    const repoRoot = (await execGit(launchPath, ["rev-parse", "--show-toplevel"])).trim();
    return new GitRepositoryAdapter(repoRoot);
  }

  get root() {
    return this.repoRoot;
  }

  resolvePath(path: string) {
    return resolveRepositoryPath(this.repoRoot, path);
  }

  async resolveCommit(ref: string) {
    return (await this.git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  }

  async readWorkingTreeStatus() {
    return parseStatus(await this.git(["status", "--porcelain=v1", "-z", "-uall"]));
  }

  async listWorkingTreeFiles(status: ReadonlyArray<StatusItem>) {
    return listWorkingTreeFiles(this.repoRoot, status);
  }

  async listCommitTreeFiles(commit: string) {
    return listCommitTreeFiles(this.repoRoot, commit);
  }

  async readCommitNameStatus(commit: string) {
    return parseCommitNameStatus(
      await this.git([
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--root",
        "-M",
        commit,
      ]),
    );
  }

  async readPatch(path: string, kind: DiffSection["kind"], untracked: boolean) {
    return getPatch(this.repoRoot, path, kind, untracked);
  }

  async readCommitPatch(commit: string, path: string) {
    const patch = await this.git([
      "show",
      "--format=",
      "--patch",
      "--no-ext-diff",
      "--find-renames",
      commit,
      "--",
      path,
    ]);

    return {
      binary: /Binary files .* differ/.test(patch),
      patch,
    };
  }

  async readFile(path: string, source: ReviewSource) {
    const absolutePath = this.resolvePath(path);

    if (source.type === "commit") {
      const commit = await this.resolveCommit(source.ref);
      return this.gitBuffer(["show", `${commit}:${path}`]);
    }

    return fs.readFile(absolutePath);
  }

  async readHistory(limit: number) {
    return this.git(["log", `--max-count=${limit}`, "--format=%H%x00%P%x00%ct%x00%s%x00"]);
  }

  private git(args: string[]) {
    return execGit(this.repoRoot, args);
  }

  private gitBuffer(args: string[]) {
    return execGitBuffer(this.repoRoot, args);
  }
}

async function createUntrackedPatch(repoRoot: string, path: string) {
  const absolutePath = resolveRepositoryPath(repoRoot, path);
  const buffer = await fs.readFile(absolutePath);

  if (isBinaryBuffer(buffer)) {
    return { binary: true, patch: "" };
  }

  const contents = buffer.toString("utf8");
  const trimmed = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split("\n") : [];
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewline = contents.endsWith("\n") ? "" : "\n\\ No newline at end of file";

  return {
    binary: false,
    patch: [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ]
      .filter(Boolean)
      .join("\n")
      .concat(noNewline, "\n"),
  };
}

async function getPatch(
  repoRoot: string,
  path: string,
  kind: DiffSection["kind"],
  untracked: boolean,
) {
  if (untracked) {
    return createUntrackedPatch(repoRoot, path);
  }

  const args =
    kind === "staged"
      ? ["diff", "--cached", "--patch", "--no-ext-diff", "--find-renames", "--", path]
      : ["diff", "--patch", "--no-ext-diff", "--find-renames", "--", path];
  const patch = await execGit(repoRoot, args);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
}

export async function readWorkingTreeState(launchPath: string): Promise<RepositoryState> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const status = await adapter.readWorkingTreeStatus();
  const treeFiles = await adapter.listWorkingTreeFiles(status);
  const files: ChangedFile[] = [];

  for (const item of status) {
    const sections: DiffSection[] = [];

    if (item.staged) {
      const staged = await adapter.readPatch(item.path, "staged", false);
      sections.push({
        binary: staged.binary,
        id: `${item.path}:staged`,
        kind: "staged",
        patch: staged.patch,
      });
    }

    if (item.unstaged) {
      const unstaged = await adapter.readPatch(item.path, "unstaged", item.untracked);
      sections.push({
        binary: unstaged.binary,
        id: `${item.path}:unstaged`,
        kind: "unstaged",
        patch: unstaged.patch,
      });
    }

    files.push({
      fingerprint: fingerprint(
        `${item.status}\n${item.oldPath ?? ""}\n${sections.map((section) => section.patch).join("\n")}`,
      ),
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: adapter.root,
    source: { type: "working-tree" },
    treeFiles,
  };
}

function parseCommitNameStatus(raw: string) {
  const parts = raw.split("\0").filter(Boolean);
  const files: Array<Pick<ChangedFile, "oldPath" | "path" | "status">> = [];

  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++];
    const statusType = statusCode?.[0];

    if (statusType === "R" || statusType === "C") {
      const oldPath = parts[index++];
      const path = parts[index++];
      if (path) files.push({ oldPath, path, status: "renamed" });
    } else {
      const path = parts[index++];
      if (path) files.push({ path, status: normalizeStatus(statusType) });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readCommitState(launchPath: string, ref: string): Promise<RepositoryState> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const commit = await adapter.resolveCommit(ref);
  const treeFiles = await adapter.listCommitTreeFiles(commit);
  const status = await adapter.readCommitNameStatus(commit);
  const files: ChangedFile[] = [];

  for (const item of status) {
    const section = await adapter.readCommitPatch(commit, item.path);

    files.push({
      fingerprint: fingerprint(`${commit}\n${item.oldPath ?? ""}\n${section.patch}`),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: section.binary,
          id: `${item.path}:${commit}`,
          kind: "commit",
          patch: section.patch,
        },
      ],
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: adapter.root,
    source: { ref: commit, type: "commit" },
    treeFiles,
  };
}

export function readRepositoryState(
  launchPath: string,
  source: ReviewSource = { type: "working-tree" },
) {
  return source.type === "commit"
    ? readCommitState(launchPath, source.ref)
    : readWorkingTreeState(launchPath);
}

export async function readRepositoryFile(
  launchPath: string,
  path: string,
  source: ReviewSource = { type: "working-tree" },
): Promise<RepositoryFile> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const buffer = await adapter.readFile(path, source);
  const binary = isBinaryBuffer(buffer);

  return {
    binary,
    contents: binary ? "" : buffer.toString("utf8"),
    fingerprint: fingerprintBuffer(buffer),
    path,
  };
}

export async function listRepositoryHistory(
  launchPath: string,
  limit = 200,
): Promise<RepositoryHistory> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const raw = await adapter.readHistory(limit);
  const parts = raw.split("\0").filter(Boolean);
  const entries: HistoryEntry[] = [];

  for (let index = 0; index < parts.length; index += 4) {
    const parents = parts[index + 1];
    entries.push({
      committedAt: Number(parts[index + 2]) * 1000,
      parents: parents ? parents.split(" ") : [],
      ref: parts[index] ?? "",
      subject: parts[index + 3] ?? "",
    });
  }

  return { entries, root: adapter.root };
}

export async function showInRepositoryFolder(
  launchPath: string,
  path: string,
  showItemInFolder: (path: string) => void,
  openPath: (path: string) => void,
) {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const absolutePath = adapter.resolvePath(path);

  if (existsSync(absolutePath)) {
    showItemInFolder(absolutePath);
  } else {
    openPath(adapter.root);
  }
}

export async function openRepositoryTarget(
  launchPath: string,
  path: string,
  target: OpenRepositoryTarget,
  showItemInFolder: (path: string) => void,
  openPath: (path: string) => void,
) {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const repositoryPath = adapter.resolvePath(path);
  const targetPath = existsSync(repositoryPath) ? repositoryPath : adapter.root;

  if (target === "finder") {
    showItemInFolder(targetPath);
    return;
  }

  const applicationName = target === "zed" ? "Zed" : "Ghostty";

  if (process.platform === "darwin") {
    await execFileAsync("open", ["-a", applicationName, targetPath]);
    return;
  }

  openPath(targetPath);
}
