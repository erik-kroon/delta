import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "bun:test";

import {
  githubRemoteMatchesPullRequest,
  normalizePullRequestFileStatus,
  parseGitHubPullRequestUrl,
  readDiffSectionContent,
  readRepositoryFile,
  readRepositoryState,
  readWorkingTreeState,
} from "./git-state";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

async function run(cwd: string, command: string, args: string[]) {
  await execFileAsync(command, args, { cwd });
}

async function git(cwd: string, args: string[]) {
  await run(cwd, "git", args);
}

async function createFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "delta-git-state-"));
  fixtureRoots.push(root);

  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Delta Test"]);
  await git(root, ["config", "user.email", "delta@example.test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "rename-me.txt"), "rename base\n");
  await writeFile(join(root, "delete-me.txt"), "delete base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);

  return realpath(root);
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("reads working tree state for staged, unstaged, untracked, renamed, and deleted files", async () => {
  const root = await createFixtureRepo();

  await writeFile(join(root, "tracked.txt"), "staged\n");
  await git(root, ["add", "tracked.txt"]);
  await writeFile(join(root, "tracked.txt"), "unstaged\n");
  await writeFile(join(root, "untracked.txt"), "new text\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await git(root, ["mv", "rename-me.txt", "renamed.txt"]);
  await git(root, ["rm", "delete-me.txt"]);

  const state = await readWorkingTreeState(root);
  const byPath = new Map(state.files.map((file) => [file.path, file]));

  expect(state.root).toBe(root);
  expect(state.source).toEqual({ type: "working-tree" });
  expect(state.treeFiles).toContain("tracked.txt");
  expect(state.treeFiles).toContain("untracked.txt");
  expect(state.treeFiles).toContain("binary.bin");
  expect(state.treeFiles).toContain("rename-me.txt");
  expect(state.treeFiles).toContain("renamed.txt");

  expect(byPath.get("tracked.txt")?.sections.map((section) => section.kind)).toEqual([
    "staged",
    "unstaged",
  ]);
  expect(byPath.get("untracked.txt")?.status).toBe("untracked");
  expect(byPath.get("untracked.txt")?.sections[0]?.patch).toContain("+new text");
  expect(byPath.get("binary.bin")?.sections[0]).toMatchObject({
    binary: true,
    kind: "unstaged",
    loadState: "unloadable",
    summary: { reason: "binary" },
  });
  expect(byPath.get("renamed.txt")).toMatchObject({
    oldPath: "rename-me.txt",
    status: "renamed",
  });
  expect(byPath.get("delete-me.txt")?.status).toBe("deleted");
});

test("summarizes unsafe working-tree section content without eager text rendering", async () => {
  const root = await createFixtureRepo();

  await writeFile(join(root, "large.txt"), `${"a".repeat(300 * 1024)}\n`);
  await writeFile(join(root, "too-large.txt"), `${"b".repeat(3 * 1024 * 1024)}\n`);
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await mkdir(join(root, "plain-dir"));
  await symlink("tracked.txt", join(root, "linked.txt"));

  const state = await readWorkingTreeState(root);
  const byPath = new Map(state.files.map((file) => [file.path, file]));

  expect(byPath.get("large.txt")?.sections[0]).toMatchObject({
    loadState: "deferred",
    patch: "",
    summary: { reason: "large" },
  });
  expect(byPath.get("too-large.txt")?.sections[0]).toMatchObject({
    loadState: "too-large",
    patch: "",
    summary: { reason: "large" },
  });
  expect(byPath.get("binary.bin")?.sections[0]).toMatchObject({
    binary: true,
    loadState: "unloadable",
    patch: "",
    summary: { reason: "binary" },
  });
  expect(byPath.get("linked.txt")?.sections[0]).toMatchObject({
    loadState: "unloadable",
    patch: "",
    summary: { reason: "symlink" },
  });
  expect(state.files.some((file) => file.path === "plain-dir")).toBe(false);
});

test("loads deferred text diff sections on demand", async () => {
  const root = await createFixtureRepo();
  const contents = `${"loaded\n".repeat(40_000)}`;
  await writeFile(join(root, "large.txt"), contents);

  const state = await readWorkingTreeState(root);
  expect(state.files.find((file) => file.path === "large.txt")?.sections[0]?.loadState).toBe(
    "deferred",
  );

  const section = await readDiffSectionContent(root, "large.txt", "unstaged");

  expect(section).toMatchObject({
    binary: false,
    kind: "unstaged",
    loadState: "loaded",
  });
  expect(section.patch).toContain("+loaded");
});

test("returns an error summary when deferred untracked content disappears", async () => {
  const root = await createFixtureRepo();
  await writeFile(join(root, "large.txt"), `${"missing\n".repeat(40_000)}`);

  const state = await readWorkingTreeState(root);
  expect(state.files.find((file) => file.path === "large.txt")?.sections[0]?.loadState).toBe(
    "deferred",
  );

  await rm(join(root, "large.txt"));
  const section = await readDiffSectionContent(root, "large.txt", "unstaged");

  expect(section).toMatchObject({
    loadState: "error",
    patch: "",
    summary: { reason: "missing" },
  });
});

test("reads commit state from a verified commit ref", async () => {
  const root = await createFixtureRepo();

  await writeFile(join(root, "tracked.txt"), "commit change\n");
  await writeFile(join(root, "added.txt"), "added\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "second"]);

  const state = await readRepositoryState(root, { ref: "HEAD", type: "commit" });
  const byPath = new Map(state.files.map((file) => [file.path, file]));

  expect(state.source.type).toBe("commit");
  expect(state.treeFiles).toContain("tracked.txt");
  expect(state.treeFiles).toContain("added.txt");
  expect(byPath.get("tracked.txt")?.sections[0]?.kind).toBe("commit");
  expect(byPath.get("tracked.txt")?.sections[0]?.patch).toContain("+commit change");
  expect(byPath.get("added.txt")?.status).toBe("added");
});

test("reads repository files and rejects paths that escape the repository", async () => {
  const root = await createFixtureRepo();

  const file = await readRepositoryFile(root, "tracked.txt");
  expect(file).toMatchObject({
    binary: false,
    contents: "base\n",
    path: "tracked.txt",
  });

  await expect(readRepositoryFile(root, "../outside.txt")).rejects.toThrow(
    "Repository file path escapes the repository root.",
  );
});

test("parses GitHub pull request URLs", () => {
  expect(parseGitHubPullRequestUrl("https://github.com/pierre/delta/pull/42")).toEqual({
    number: 42,
    owner: "pierre",
    repo: "delta",
    url: "https://github.com/pierre/delta/pull/42",
  });

  expect(() => parseGitHubPullRequestUrl("https://github.com/pierre/delta/issues/42")).toThrow(
    "Pull request source must be a GitHub pull request URL.",
  );
});

test("matches GitHub PR URLs against HTTPS and SSH remotes", () => {
  const pullRequest = parseGitHubPullRequestUrl("https://github.com/pierre/delta/pull/42");

  expect(
    githubRemoteMatchesPullRequest(
      ["https://github.com/pierre/delta.git", "git@github.com:other/project.git"],
      pullRequest,
    ),
  ).toBe(true);
  expect(githubRemoteMatchesPullRequest(["git@github.com:pierre/delta.git"], pullRequest)).toBe(
    true,
  );
  expect(githubRemoteMatchesPullRequest(["https://github.com/pierre/other.git"], pullRequest)).toBe(
    false,
  );
});

test("normalizes GitHub pull request file statuses", () => {
  expect(normalizePullRequestFileStatus("added")).toBe("added");
  expect(normalizePullRequestFileStatus("removed")).toBe("deleted");
  expect(normalizePullRequestFileStatus("renamed")).toBe("renamed");
  expect(normalizePullRequestFileStatus("modified")).toBe("modified");
  expect(normalizePullRequestFileStatus("changed")).toBe("modified");
});
