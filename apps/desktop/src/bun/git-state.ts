import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ChangedFile,
  DiffSection,
  GitFileStatus,
  HistoryEntry,
  OpenRepositoryTarget,
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

async function git(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
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
      oldPath = path;
      path = parts[++index] ?? path;
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

function isBinaryBuffer(buffer: Buffer) {
  return buffer.includes(0);
}

async function createUntrackedPatch(repoRoot: string, path: string) {
  const absolutePath = join(repoRoot, path);
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
  const patch = await git(repoRoot, args);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
}

export async function readWorkingTreeState(launchPath: string): Promise<RepositoryState> {
  const repoRoot = (await git(launchPath, ["rev-parse", "--show-toplevel"])).trim();
  const status = parseStatus(await git(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]));
  const files: ChangedFile[] = [];

  for (const item of status) {
    const sections: DiffSection[] = [];

    if (item.staged) {
      const staged = await getPatch(repoRoot, item.path, "staged", false);
      sections.push({
        binary: staged.binary,
        id: `${item.path}:staged`,
        kind: "staged",
        patch: staged.patch,
      });
    }

    if (item.unstaged) {
      const unstaged = await getPatch(repoRoot, item.path, "unstaged", item.untracked);
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
    root: repoRoot,
    source: { type: "working-tree" },
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
  const repoRoot = (await git(launchPath, ["rev-parse", "--show-toplevel"])).trim();
  const commit = (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  const status = parseCommitNameStatus(
    await git(repoRoot, [
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
  const files: ChangedFile[] = [];

  for (const item of status) {
    const patch = await git(repoRoot, [
      "show",
      "--format=",
      "--patch",
      "--no-ext-diff",
      "--find-renames",
      commit,
      "--",
      item.path,
    ]);

    files.push({
      fingerprint: fingerprint(`${commit}\n${item.oldPath ?? ""}\n${patch}`),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: /Binary files .* differ/.test(patch),
          id: `${item.path}:${commit}`,
          kind: "commit",
          patch,
        },
      ],
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: { ref: commit, type: "commit" },
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

export async function listRepositoryHistory(
  launchPath: string,
  limit = 200,
): Promise<RepositoryHistory> {
  const repoRoot = (await git(launchPath, ["rev-parse", "--show-toplevel"])).trim();
  const raw = await git(repoRoot, [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x00%P%x00%ct%x00%s%x00",
  ]);
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

  return { entries, root: repoRoot };
}

export async function showInRepositoryFolder(
  launchPath: string,
  path: string,
  showItemInFolder: (path: string) => void,
  openPath: (path: string) => void,
) {
  const state = await readWorkingTreeState(launchPath);
  const absolutePath = resolve(state.root, path);

  if (existsSync(absolutePath)) {
    showItemInFolder(absolutePath);
  } else {
    openPath(state.root);
  }
}

export async function openRepositoryTarget(
  launchPath: string,
  path: string,
  target: OpenRepositoryTarget,
  showItemInFolder: (path: string) => void,
  openPath: (path: string) => void,
) {
  const state = await readWorkingTreeState(launchPath);
  const repositoryPath = resolve(state.root, path);
  const targetPath = existsSync(repositoryPath) ? repositoryPath : state.root;

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
