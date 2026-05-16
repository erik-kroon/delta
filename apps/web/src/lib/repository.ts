export type DiffSectionKind = "commit" | "staged" | "unstaged";

export type DiffSection = {
  binary: boolean;
  id: string;
  kind: DiffSectionKind;
  patch: string;
};

export type GitFileStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

export type ChangedFile = {
  fingerprint: string;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type ReviewSource =
  | {
      type: "working-tree";
    }
  | {
      ref: string;
      type: "commit";
    };

export type OpenRepositoryTarget = "finder" | "zed" | "ghostty";

export type HistoryEntry = {
  committedAt: number;
  parents: ReadonlyArray<string>;
  ref: string;
  subject: string;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryFile = {
  binary: boolean;
  contents: string;
  fingerprint: string;
  path: string;
};

export type RepositoryState = {
  files: ReadonlyArray<ChangedFile>;
  generatedAt: number;
  launchPath: string;
  root: string;
  source: ReviewSource;
  treeFiles: ReadonlyArray<string>;
};

const samplePatch = `diff --git a/apps/web/src/routes/index.tsx b/apps/web/src/routes/index.tsx
index 1111111..2222222 100644
--- a/apps/web/src/routes/index.tsx
+++ b/apps/web/src/routes/index.tsx
@@ -1,7 +1,12 @@
 import { createFileRoute } from "@tanstack/solid-router";
+import { GitBranch, RefreshCcw } from "lucide-solid";
 
 export const Route = createFileRoute("/")({
   component: App,
 });
 
 function App() {
-  return <main>Delta</main>;
+  return (
+    <main class="delta-shell">
+      <DiffWorkspace />
+    </main>
+  );
 }`;

const sampleTreePatch = `diff --git a/apps/web/src/lib/repository.ts b/apps/web/src/lib/repository.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/apps/web/src/lib/repository.ts
@@ -0,0 +1,8 @@
+export type GitFileStatus = "added" | "deleted" | "modified";
+
+export type ChangedFile = {
+  path: string;
+  status: GitFileStatus;
+};
+
+export type RepositoryState = { files: ChangedFile[] };`;

export const sampleRepositoryFiles: Record<string, RepositoryFile> = {
  ".gitignore": {
    binary: false,
    contents: "node_modules\n.dist\n.DS_Store\n",
    fingerprint: "sample-file-gitignore",
    path: ".gitignore",
  },
  "apps/web/src/styles.css": {
    binary: false,
    contents: ":root {\n  color-scheme: light dark;\n}\n\nbody {\n  margin: 0;\n}\n",
    fingerprint: "sample-file-styles",
    path: "apps/web/src/styles.css",
  },
  "package.json": {
    binary: false,
    contents: '{\n  "name": "delta",\n  "private": true,\n  "type": "module"\n}\n',
    fingerprint: "sample-file-package",
    path: "package.json",
  },
  "README.md": {
    binary: false,
    contents: "# Delta\n\nA desktop diff review workspace.\n",
    fingerprint: "sample-file-readme",
    path: "README.md",
  },
};

export const sampleRepositoryState: RepositoryState = {
  files: [
    {
      fingerprint: "sample-route",
      path: "apps/web/src/routes/index.tsx",
      sections: [
        { binary: false, id: "sample-route:unstaged", kind: "unstaged", patch: samplePatch },
      ],
      status: "modified",
    },
    {
      fingerprint: "sample-repository",
      path: "apps/web/src/lib/repository.ts",
      sections: [
        {
          binary: false,
          id: "sample-repository:unstaged",
          kind: "unstaged",
          patch: sampleTreePatch,
        },
      ],
      status: "added",
    },
  ],
  generatedAt: Date.now(),
  launchPath: "browser-preview",
  root: "browser-preview",
  source: { type: "working-tree" },
  treeFiles: [
    ".gitignore",
    "apps/desktop/src/bun/git-state.ts",
    "apps/desktop/src/bun/index.ts",
    "apps/web/src/lib/delta-client.ts",
    "apps/web/src/lib/repository.ts",
    "apps/web/src/routes/index.tsx",
    "apps/web/src/styles.css",
    "package.json",
    "README.md",
  ],
};
