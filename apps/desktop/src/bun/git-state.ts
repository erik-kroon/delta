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
  PullRequestReviewComment,
  RepositoryFile,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from "../../../web/src/lib/repository";

const execFileAsync = promisify(execFile);
const eagerDiffByteThreshold = 256 * 1024;
const maxLoadableDiffByteThreshold = 2 * 1024 * 1024;

type StatusItem = {
  oldPath?: string;
  path: string;
  staged: boolean;
  status: GitFileStatus;
  unstaged: boolean;
  untracked: boolean;
};

type GitHubPullRequestUrl = {
  number: number;
  owner: string;
  repo: string;
  url: string;
};

type GitHubPullRequestFile = {
  filename: string;
  patch?: string;
  previous_filename?: string;
  status: string;
};

type GitHubPullRequestDetails = {
  base?: { sha?: string };
  head?: { sha?: string };
  html_url?: string;
  number?: number;
  title?: string;
};

type GitHubReviewComment = {
  body?: string;
  created_at?: string;
  html_url?: string;
  id?: number | string;
  line?: number;
  original_line?: number;
  original_start_line?: number;
  path?: string;
  side?: string;
  start_line?: number;
  start_side?: string;
  user?: {
    avatar_url?: string;
    html_url?: string;
    login?: string;
  };
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

async function execGhJson(args: string[]) {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(stdout) as unknown;
  } catch (caught) {
    throw normalizeGhError(caught);
  }
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

function summarizePatch(patch: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, bytes: Buffer.byteLength(patch), deletions };
}

function loadedSection(
  path: string,
  kind: DiffSection["kind"],
  patch: string,
  binary: boolean,
): DiffSection {
  return {
    binary,
    id: `${path}:${kind}`,
    kind,
    loadState: "loaded",
    patch,
    summary: summarizePatch(patch),
  };
}

function summarySection({
  binary = false,
  kind,
  loadState,
  message,
  path,
  reason,
  summary,
}: {
  binary?: boolean;
  kind: DiffSection["kind"];
  loadState: DiffSection["loadState"];
  message: string;
  path: string;
  reason: NonNullable<DiffSection["summary"]>["reason"];
  summary?: Partial<NonNullable<DiffSection["summary"]>>;
}): DiffSection {
  return {
    binary,
    id: `${path}:${kind}`,
    kind,
    loadState,
    patch: "",
    summary: {
      ...summary,
      message,
      reason,
    },
  };
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

export function normalizePullRequestFileStatus(status: string): GitFileStatus {
  if (status === "added") return "added";
  if (status === "removed") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}

export function parseGitHubPullRequestUrl(sourceUrl: string): GitHubPullRequestUrl {
  let url: URL;

  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("Pull request source must be a GitHub pull request URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, pullSegment, numberText] = parts;
  const number = Number(numberText);

  if (
    url.hostname !== "github.com" ||
    !owner ||
    !repo ||
    pullSegment !== "pull" ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    throw new Error("Pull request source must be a GitHub pull request URL.");
  }

  return {
    number,
    owner,
    repo: repo.replace(/\.git$/, ""),
    url: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}/pull/${number}`,
  };
}

function parseGitHubRemoteUrl(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, "") };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return undefined;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return undefined;
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return undefined;
  }
}

export function githubRemoteMatchesPullRequest(
  remoteUrls: ReadonlyArray<string>,
  pullRequest: Pick<GitHubPullRequestUrl, "owner" | "repo">,
) {
  return remoteUrls.some((remoteUrl) => {
    const remote = parseGitHubRemoteUrl(remoteUrl);
    return (
      remote?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
      remote.repo.toLowerCase() === pullRequest.repo.toLowerCase()
    );
  });
}

function normalizeGhError(caught: unknown) {
  const code = caught && typeof caught === "object" ? (caught as { code?: string }).code : "";
  const stderr =
    caught &&
    typeof caught === "object" &&
    typeof (caught as { stderr?: unknown }).stderr === "string"
      ? (caught as { stderr: string }).stderr
      : "";
  const message = caught instanceof Error ? caught.message : String(caught);
  const text = `${stderr}\n${message}`.toLowerCase();

  if (code === "ENOENT") {
    return new Error("GitHub CLI (gh) is not installed or is not available on PATH.");
  }

  if (
    text.includes("not logged into") ||
    text.includes("authentication") ||
    text.includes("authenticate") ||
    text.includes("requires authentication") ||
    text.includes("bad credentials")
  ) {
    return new Error("GitHub CLI (gh) is not authenticated. Run gh auth login, then try again.");
  }

  return new Error("GitHub CLI (gh) could not read the pull request.");
}

function fromGitHubReviewSide(side: string | undefined): PullRequestReviewComment["side"] {
  return side === "LEFT" ? "deletions" : "additions";
}

function isGitHubReviewSide(side: string | undefined) {
  return side === "LEFT" || side === "RIGHT";
}

function firstNumber(...values: Array<unknown>) {
  return values.find((value): value is number => typeof value === "number");
}

export function normalizeGitHubReviewComment(
  comment: GitHubReviewComment,
): PullRequestReviewComment | null {
  const lineNumber = firstNumber(comment.line, comment.original_line);
  if (lineNumber == null || !comment.path || !comment.body || comment.id == null) {
    return null;
  }

  const side = fromGitHubReviewSide(comment.side);
  const startLineNumber = firstNumber(comment.start_line, comment.original_start_line);
  const startSide = isGitHubReviewSide(comment.start_side)
    ? fromGitHubReviewSide(comment.start_side)
    : undefined;
  const hasRange =
    startLineNumber != null && (startLineNumber !== lineNumber || (startSide ?? side) !== side);

  return {
    author: {
      avatarUrl: comment.user?.avatar_url,
      login: comment.user?.login || "GitHub user",
      url: comment.user?.html_url,
    },
    body: comment.body,
    filePath: comment.path,
    id: `github:${comment.id}`,
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    submittedAt: comment.created_at,
    url: comment.html_url,
  };
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

  async readRemoteUrls() {
    return (await this.git(["remote", "-v"]))
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((url): url is string => Boolean(url));
  }

  async isTracked(path: string) {
    try {
      await this.git(["ls-files", "--error-unmatch", "--", path]);
      return true;
    } catch {
      return false;
    }
  }

  async readPatch(path: string, kind: DiffSection["kind"], untracked: boolean, forceLoad = false) {
    return getPatch(this.repoRoot, path, kind, untracked, forceLoad);
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

    const binary = /Binary files .* differ/.test(patch);
    return binary
      ? summarySection({
          binary: true,
          kind: "commit",
          loadState: "unloadable",
          message: "Binary file changed.",
          path,
          reason: "binary",
          summary: { bytes: Buffer.byteLength(patch) },
        })
      : loadedSection(path, "commit", patch, false);
  }

  async readFile(path: string, source: ReviewSource) {
    const absolutePath = this.resolvePath(path);

    if (source.type === "commit") {
      const commit = await this.resolveCommit(source.ref);
      return this.gitBuffer(["show", `${commit}:${path}`]);
    }

    if (source.type === "pull-request") {
      throw new Error("Pull request review sources only expose changed file patches.");
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

async function createUntrackedPatch(repoRoot: string, path: string, forceLoad = false) {
  const absolutePath = resolveRepositoryPath(repoRoot, path);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (caught) {
    const code = caught && typeof caught === "object" ? (caught as { code?: string }).code : "";
    if (code === "ENOENT") {
      return summarySection({
        kind: "unstaged",
        loadState: "error",
        message: "File is missing from the working tree.",
        path,
        reason: "missing",
      });
    }
    throw caught;
  }

  if (stat.isSymbolicLink()) {
    return summarySection({
      kind: "unstaged",
      loadState: "unloadable",
      message: "Symlink target changes are shown as a summary.",
      path,
      reason: "symlink",
      summary: { bytes: stat.size },
    });
  }

  if (stat.isDirectory()) {
    return summarySection({
      kind: "unstaged",
      loadState: "unloadable",
      message: "Directory changes are shown in the file tree.",
      path,
      reason: "directory",
    });
  }

  if (stat.size > maxLoadableDiffByteThreshold) {
    return summarySection({
      kind: "unstaged",
      loadState: "too-large",
      message: "Text diff was skipped because the file is too large to render.",
      path,
      reason: "large",
      summary: { bytes: stat.size },
    });
  }

  if (!forceLoad && stat.size > eagerDiffByteThreshold) {
    return summarySection({
      kind: "unstaged",
      loadState: "deferred",
      message: "Diff content is available on demand.",
      path,
      reason: "large",
      summary: { bytes: stat.size },
    });
  }

  const buffer = await fs.readFile(absolutePath);

  if (isBinaryBuffer(buffer)) {
    return summarySection({
      binary: true,
      kind: "unstaged",
      loadState: "unloadable",
      message: "Binary file changed.",
      path,
      reason: "binary",
      summary: { bytes: buffer.byteLength },
    });
  }

  const contents = buffer.toString("utf8");
  const trimmed = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split("\n") : [];
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewline = contents.endsWith("\n") ? "" : "\n\\ No newline at end of file";

  return loadedSection(
    path,
    "unstaged",
    [
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
    false,
  );
}

async function getPatch(
  repoRoot: string,
  path: string,
  kind: DiffSection["kind"],
  untracked: boolean,
  forceLoad = false,
) {
  if (untracked) {
    return createUntrackedPatch(repoRoot, path, forceLoad);
  }

  const args =
    kind === "staged"
      ? ["diff", "--cached", "--patch", "--no-ext-diff", "--find-renames", "--", path]
      : ["diff", "--patch", "--no-ext-diff", "--find-renames", "--", path];
  const patch = await execGit(repoRoot, args);
  const binary = /Binary files .* differ/.test(patch);

  if (binary) {
    return summarySection({
      binary: true,
      kind,
      loadState: "unloadable",
      message: "Binary file changed.",
      path,
      reason: "binary",
      summary: { bytes: Buffer.byteLength(patch) },
    });
  }

  const patchBytes = Buffer.byteLength(patch);
  if (patchBytes > maxLoadableDiffByteThreshold) {
    return summarySection({
      kind,
      loadState: "too-large",
      message: "Text diff was skipped because the patch is too large to render.",
      path,
      reason: "large",
      summary: { bytes: patchBytes },
    });
  }

  if (!forceLoad && patchBytes > eagerDiffByteThreshold) {
    return summarySection({
      kind,
      loadState: "deferred",
      message: "Diff content is available on demand.",
      path,
      reason: "large",
      summary: summarizePatch(patch),
    });
  }

  return loadedSection(path, kind, patch, false);
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
      sections.push(staged);
    }

    if (item.unstaged) {
      const unstaged = await adapter.readPatch(item.path, "unstaged", item.untracked);
      sections.push(unstaged);
    }

    files.push({
      fingerprint: fingerprint(
        `${item.status}\n${item.oldPath ?? ""}\n${sections
          .map(
            (section) =>
              `${section.id}:${section.loadState}:${section.patch}:${section.summary?.message ?? ""}`,
          )
          .join("\n")}`,
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
      sections: [{ ...section, id: `${item.path}:${commit}` }],
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

async function readPullRequestDetails(pullRequest: GitHubPullRequestUrl) {
  return (await execGhJson([
    "api",
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  ])) as GitHubPullRequestDetails;
}

async function readPullRequestFiles(pullRequest: GitHubPullRequestUrl) {
  const pages = (await execGhJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files`,
  ])) as GitHubPullRequestFile[] | GitHubPullRequestFile[][];

  return Array.isArray(pages[0])
    ? (pages as GitHubPullRequestFile[][]).flat()
    : (pages as GitHubPullRequestFile[]);
}

async function readPullRequestComments(pullRequest: GitHubPullRequestUrl) {
  const pages = (await execGhJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments?per_page=100`,
  ])) as GitHubReviewComment[] | GitHubReviewComment[][];

  const comments = Array.isArray(pages[0])
    ? (pages as GitHubReviewComment[][]).flat()
    : (pages as GitHubReviewComment[]);

  return comments
    .map((comment) => normalizeGitHubReviewComment(comment))
    .filter((comment): comment is PullRequestReviewComment => comment != null);
}

function patchForPullRequestFile(file: GitHubPullRequestFile) {
  if (file.patch) return file.patch;

  const previousPath = file.previous_filename ?? file.filename;
  return [
    `diff --git a/${previousPath} b/${file.filename}`,
    `Binary files a/${previousPath} and b/${file.filename} differ`,
    "",
  ].join("\n");
}

async function readPullRequestState(
  launchPath: string,
  source: Extract<ReviewSource, { type: "pull-request" }>,
): Promise<RepositoryState> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const remoteUrls = await adapter.readRemoteUrls();

  if (!githubRemoteMatchesPullRequest(remoteUrls, pullRequest)) {
    throw new Error(
      `Pull request ${pullRequest.url} does not match any GitHub remote for this repository.`,
    );
  }

  let details: GitHubPullRequestDetails;
  let pullRequestFiles: GitHubPullRequestFile[];
  let reviewComments: PullRequestReviewComment[];

  try {
    [details, pullRequestFiles, reviewComments] = await Promise.all([
      readPullRequestDetails(pullRequest),
      readPullRequestFiles(pullRequest),
      readPullRequestComments(pullRequest),
    ]);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Unable to read GitHub pull request with gh. ${message}`);
  }

  const files = pullRequestFiles
    .map<ChangedFile>((file) => {
      const patch = patchForPullRequestFile(file);
      const status = normalizePullRequestFileStatus(file.status);

      return {
        fingerprint: fingerprint(
          `${pullRequest.url}\n${status}\n${file.previous_filename ?? ""}\n${patch}`,
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [
          {
            binary: !file.patch,
            id: `${file.filename}:pull-request:${pullRequest.number}`,
            kind: "pull-request",
            loadState: file.patch ? "loaded" : "unloadable",
            patch,
            summary: file.patch
              ? summarizePatch(patch)
              : {
                  bytes: Buffer.byteLength(patch),
                  message: "Binary file changed.",
                  reason: "binary",
                },
          },
        ],
        status,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: adapter.root,
    source: {
      baseRefOid: details.base?.sha,
      headRefOid: details.head?.sha,
      number: details.number ?? pullRequest.number,
      repository: `${pullRequest.owner}/${pullRequest.repo}`,
      title: details.title,
      type: "pull-request",
      url: details.html_url ?? pullRequest.url,
    },
    treeFiles: files.map((file) => file.path),
  };
}

export function readRepositoryState(
  launchPath: string,
  source: ReviewSource = { type: "working-tree" },
) {
  if (source.type === "commit") return readCommitState(launchPath, source.ref);
  if (source.type === "pull-request") return readPullRequestState(launchPath, source);
  return readWorkingTreeState(launchPath);
}

export async function readDiffSectionContent(
  launchPath: string,
  path: string,
  kind: DiffSection["kind"],
  source: ReviewSource = { type: "working-tree" },
): Promise<DiffSection> {
  const adapter = await GitRepositoryAdapter.fromLaunchPath(launchPath);

  if (source.type === "working-tree") {
    const untracked = kind === "unstaged" && !(await adapter.isTracked(path));
    return adapter.readPatch(path, kind, untracked, true);
  }

  if (source.type === "commit") {
    const commit = await adapter.resolveCommit(source.ref);
    const section = await adapter.readCommitPatch(commit, path);
    return { ...section, id: `${path}:${commit}` };
  }

  throw new Error("Pull request diff sections cannot be loaded from the local repository.");
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
