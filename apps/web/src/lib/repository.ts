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

export type RepositoryState = {
  files: ReadonlyArray<ChangedFile>;
  generatedAt: number;
  launchPath: string;
  root: string;
  source: ReviewSource;
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
};
