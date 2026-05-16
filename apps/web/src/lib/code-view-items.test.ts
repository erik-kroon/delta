import { describe, expect, it } from "vitest";

import {
  buildCodeViewItemModel,
  diffItemId,
  parseSectionDiff,
  previewItemId,
} from "@/lib/code-view-items";
import type { ChangedFile, DiffSection, RepositoryFile } from "@/lib/repository";

const stagedPatch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const keep = true;
-const oldValue = 1;
+const newValue = 2;
+const extra = true;
 export { keep };
`;

const unstagedPatch = `diff --git a/src/app.ts b/src/app.ts
index 2222222..3333333 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const keep = true;
-const newValue = 2;
+const newValue = 3;
 export { keep };
`;

function section(id: string, kind: DiffSection["kind"], patch: string): DiffSection {
  return { binary: false, id, kind, patch };
}

function changedFile(patch: Partial<ChangedFile> = {}): ChangedFile {
  return {
    fingerprint: "fingerprint-1",
    path: "src/app.ts",
    sections: [
      section("src/app.ts:staged", "staged", stagedPatch),
      section("src/app.ts:unstaged", "unstaged", unstagedPatch),
    ],
    status: "modified",
    ...patch,
  };
}

describe("buildCodeViewItemModel", () => {
  it("projects staged and unstaged sections into diff items and metadata", () => {
    const file = changedFile();
    const model = buildCodeViewItemModel({
      collapsed: new Set(),
      files: [file],
      previewFile: null,
      viewed: {},
    });

    expect(model.items).toHaveLength(2);
    expect(model.items.map((item) => item.id)).toEqual([
      "diff:src/app.ts:staged",
      "diff:src/app.ts:unstaged",
    ]);
    expect(model.items.map((item) => item.version)).toEqual([
      "fingerprint-1:src/app.ts:staged:open:pending:0",
      "fingerprint-1:src/app.ts:unstaged:open:pending:1",
    ]);
    expect(model.fileStartItemIdByPath.get("src/app.ts")).toBe("diff:src/app.ts:staged");
    expect(model.itemMetadata.get("diff:src/app.ts:unstaged")).toMatchObject({
      file,
      isCollapsed: false,
      isViewed: false,
      section: file.sections[1],
      sectionCount: 2,
    });
  });

  it("projects collapsed files as one closed item", () => {
    const file = changedFile();
    const model = buildCodeViewItemModel({
      collapsed: new Set([file.path]),
      files: [file],
      previewFile: null,
      viewed: {},
    });

    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      collapsed: true,
      id: "diff:src/app.ts:staged",
      type: "diff",
      version: "fingerprint-1:src/app.ts:staged:closed:pending:0",
    });
    expect(model.itemMetadata.get("diff:src/app.ts:staged")).toMatchObject({
      isCollapsed: true,
      isViewed: false,
      sectionCount: 2,
    });
  });

  it("projects viewed files as collapsed viewed items", () => {
    const file = changedFile();
    const model = buildCodeViewItemModel({
      collapsed: new Set(),
      files: [file],
      previewFile: null,
      viewed: { [file.path]: file.fingerprint },
    });

    expect(model.items).toHaveLength(1);
    expect(model.items[0]?.version).toBe("fingerprint-1:src/app.ts:staged:closed:viewed:0");
    expect(model.itemMetadata.get("diff:src/app.ts:staged")).toMatchObject({
      isCollapsed: true,
      isViewed: true,
    });
  });

  it("preserves renamed file metadata in parsed diffs", () => {
    const file = changedFile({
      oldPath: "src/old-app.ts",
      path: "src/app.ts",
      status: "renamed",
    });
    const parsed = parseSectionDiff(file, file.sections[0]!);

    expect(parsed.name).toBe("src/app.ts");
    expect(parsed.prevName).toBe("src/old-app.ts");
    expect(parsed.cacheKey).toBe("fingerprint-1:src/app.ts:staged");
  });

  it("uses binary fallback diffs when a section is binary", () => {
    const binarySection: DiffSection = {
      binary: true,
      id: "assets/logo.png:unstaged",
      kind: "unstaged",
      patch: "Binary files a/assets/logo.png and b/assets/logo.png differ\n",
    };
    const file = changedFile({
      fingerprint: "binary-fingerprint",
      path: "assets/logo.png",
      sections: [binarySection],
      status: "modified",
    });
    const model = buildCodeViewItemModel({
      collapsed: new Set(),
      files: [file],
      previewFile: null,
      viewed: {},
    });
    const item = model.items[0];

    expect(item).toMatchObject({
      id: "diff:assets/logo.png:unstaged",
      type: "diff",
      version: "binary-fingerprint:assets/logo.png:unstaged:open:pending:0",
    });
    expect(item?.type === "diff" ? item.fileDiff : undefined).toMatchObject({
      additionLines: ["Binary file changed\n"],
      cacheKey: "binary:binary-fingerprint:assets/logo.png:unstaged",
      name: "assets/logo.png",
      type: "change",
    });
  });

  it("projects preview files instead of changed diffs", () => {
    const previewFile: RepositoryFile = {
      binary: false,
      contents: "readme\n",
      fingerprint: "preview-fingerprint",
      path: "README.md",
    };
    const model = buildCodeViewItemModel({
      collapsed: new Set(),
      files: [changedFile()],
      previewFile,
      viewed: {},
    });

    expect(model.items).toEqual([
      {
        file: {
          cacheKey: "preview-fingerprint",
          contents: "readme\n",
          name: "README.md",
        },
        id: "file:README.md",
        type: "file",
        version: "preview-fingerprint:text",
      },
    ]);
    expect(model.itemMetadata.size).toBe(0);
    expect(model.fileStartItemIdByPath.get("README.md")).toBe("file:README.md");
  });

  it("uses binary contents for binary preview files", () => {
    const model = buildCodeViewItemModel({
      collapsed: new Set(),
      files: [],
      previewFile: {
        binary: true,
        contents: "",
        fingerprint: "binary-preview",
        path: "assets/logo.png",
      },
      viewed: {},
    });

    expect(model.items[0]).toMatchObject({
      file: {
        cacheKey: "binary-preview",
        contents: "Binary file\n",
        name: "assets/logo.png",
      },
      id: "file:assets/logo.png",
      type: "file",
      version: "binary-preview:binary",
    });
  });
});

describe("item ids", () => {
  it("derives stable ids for diff and preview items", () => {
    expect(diffItemId(section("src/app.ts:staged", "staged", stagedPatch))).toBe(
      "diff:src/app.ts:staged",
    );
    expect(previewItemId("README.md")).toBe("file:README.md");
  });
});
