import {
  parsePatchFiles,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from "@pierre/diffs";

import type {
  ChangedFile,
  DiffSection,
  PullRequestReviewComment,
  RepositoryFile,
} from "@/lib/repository";

export type ReviewAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
};

export type DiffItemMetadata = {
  file: ChangedFile;
  isCollapsed: boolean;
  isViewed: boolean;
  section: DiffSection;
  sectionCount: number;
};

export type CodeViewItemModel = {
  fileStartItemIdByPath: Map<string, string>;
  itemMetadata: Map<string, DiffItemMetadata>;
  items: CodeViewItem<ReviewAnnotationMetadata>[];
};

export type CodeViewItemModelInput = {
  collapsed: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  previewFile: RepositoryFile | null;
  reviewComments: ReadonlyArray<PullRequestReviewComment>;
  viewed: Readonly<Record<string, string>>;
};

const parsedSectionDiffs = new WeakMap<DiffSection, FileDiffMetadata>();

export function diffItemId(section: DiffSection) {
  return `diff:${section.id}`;
}

export function previewItemId(path: string) {
  return `file:${path}`;
}

function sectionSummaryText(section: DiffSection) {
  if (section.loadState === "deferred") return section.summary?.message ?? "Diff deferred.";
  if (section.loadState === "too-large") return section.summary?.message ?? "Diff too large.";
  if (section.loadState === "error") return section.summary?.message ?? "Diff failed to load.";
  if (section.summary?.message) return section.summary.message;
  return section.binary ? "Binary file changed." : "Diff content unavailable.";
}

function createSummaryFileDiff(file: ChangedFile, section: DiffSection): FileDiffMetadata {
  const text = `${sectionSummaryText(section)}\n`;
  return {
    additionLines: [text],
    cacheKey: `summary:${file.fingerprint}:${section.id}:${section.loadState}:${section.summary?.message ?? ""}`,
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
    isPartial: section.loadState !== "loaded",
    name: file.path,
    prevName: file.oldPath,
    splitLineCount: 1,
    type: file.status === "deleted" ? "deleted" : file.status === "added" ? "new" : "change",
    unifiedLineCount: 1,
  };
}

export function parseSectionDiff(file: ChangedFile, section: DiffSection): FileDiffMetadata {
  const cached = parsedSectionDiffs.get(section);
  if (cached) return cached;

  let parsedDiff: FileDiffMetadata;
  if (section.binary || section.loadState !== "loaded") {
    parsedDiff = createSummaryFileDiff(file, section);
    parsedSectionDiffs.set(section, parsedDiff);
    return parsedDiff;
  }

  const parsedFile = parsePatchFiles(section.patch, section.id)[0]?.files[0];
  if (!parsedFile) {
    parsedDiff = createSummaryFileDiff(file, section);
    parsedSectionDiffs.set(section, parsedDiff);
    return parsedDiff;
  }

  parsedDiff = {
    ...parsedFile,
    cacheKey: `${file.fingerprint}:${section.id}`,
    name: file.path,
    prevName: file.oldPath ?? parsedFile.prevName,
  };
  parsedSectionDiffs.set(section, parsedDiff);
  return parsedDiff;
}

function buildReviewCommentAnnotations(
  file: ChangedFile,
  section: DiffSection,
  reviewComments: ReadonlyArray<PullRequestReviewComment>,
): DiffLineAnnotation<ReviewAnnotationMetadata>[] | undefined {
  const annotations = reviewComments
    .filter((comment) => comment.filePath === file.path)
    .map<DiffLineAnnotation<ReviewAnnotationMetadata>>((comment) => ({
      lineNumber: comment.lineNumber,
      metadata: { commentIds: [comment.id] },
      side: comment.side,
    }));

  return section.kind === "pull-request" && annotations.length > 0 ? annotations : undefined;
}

export function buildCodeViewItemModel({
  collapsed,
  files,
  previewFile,
  reviewComments,
  viewed,
}: CodeViewItemModelInput): CodeViewItemModel {
  const items: CodeViewItem<ReviewAnnotationMetadata>[] = [];
  const fileStartItemIdByPath = new Map<string, string>();
  const itemMetadata = new Map<string, DiffItemMetadata>();

  if (previewFile) {
    const id = previewItemId(previewFile.path);
    fileStartItemIdByPath.set(previewFile.path, id);
    items.push({
      file: {
        cacheKey: previewFile.fingerprint,
        contents: previewFile.binary ? "Binary file\n" : previewFile.contents,
        name: previewFile.path,
      },
      id,
      type: "file",
      version: `${previewFile.fingerprint}:${previewFile.binary ? "binary" : "text"}`,
    });
    return { fileStartItemIdByPath, itemMetadata, items };
  }

  for (const file of files) {
    const isViewed = viewed[file.path] === file.fingerprint;
    const isCollapsed = collapsed.has(file.path) || isViewed;
    const sections = isCollapsed ? file.sections.slice(0, 1) : file.sections;

    for (const [index, section] of sections.entries()) {
      const id = diffItemId(section);
      const fileDiff = parseSectionDiff(file, section);
      itemMetadata.set(id, {
        file,
        isCollapsed,
        isViewed,
        section,
        sectionCount: file.sections.length,
      });
      if (!fileStartItemIdByPath.has(file.path)) {
        fileStartItemIdByPath.set(file.path, id);
      }
      items.push({
        annotations: buildReviewCommentAnnotations(file, section, reviewComments),
        collapsed: isCollapsed,
        fileDiff,
        id,
        type: "diff",
        version: `${file.fingerprint}:${section.id}:${section.loadState}:${section.summary?.message ?? ""}:${isCollapsed ? "closed" : "open"}:${isViewed ? "viewed" : "pending"}:${index}`,
      });
    }
  }

  return { fileStartItemIdByPath, itemMetadata, items };
}
