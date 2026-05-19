import type { DeltaRPCSchema } from "./delta-rpc-schema";
import {
  samplePullRequestRepositoryState,
  sampleRepositoryFiles,
  sampleRepositoryState,
  type OpenRepositoryTarget,
  type RepositoryFile,
  type RepositoryState,
  type ReviewSource,
} from "./repository";

type DeltaClient = {
  getRepositoryFile: (path: string, source?: ReviewSource) => Promise<RepositoryFile>;
  getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
  openRepository: (path: string, target: OpenRepositoryTarget) => Promise<void>;
  showInFolder: (path: string) => Promise<void>;
};

type DeltaRPC = ReturnType<typeof import("electrobun/view").Electroview.defineRPC<DeltaRPCSchema>>;

let rpc: DeltaRPC | undefined;
let initialized = false;

function isElectrobunWebview() {
  return typeof window !== "undefined" && "__electrobun" in window;
}

async function getRPC() {
  if (!isElectrobunWebview()) {
    return undefined;
  }

  if (!rpc) {
    const { Electroview } = await import("electrobun/view");
    rpc = Electroview.defineRPC<DeltaRPCSchema>({
      handlers: { messages: {}, requests: {} },
      maxRequestTime: Infinity,
    });
  }

  if (!initialized) {
    const { Electroview } = await import("electrobun/view");
    new Electroview({ rpc });
    initialized = true;
  }

  return rpc;
}

export const deltaClient: DeltaClient = {
  async getRepositoryFile(path, source) {
    const activeRPC = await getRPC();
    if (!activeRPC) {
      return (
        sampleRepositoryFiles[path] ?? {
          binary: false,
          contents: "",
          fingerprint: `sample-file-empty:${path}`,
          path,
        }
      );
    }

    return activeRPC.request.getRepositoryFile({ path, source });
  },

  async getRepositoryState(source = readSourceFromLocation()) {
    const activeRPC = await getRPC();
    if (!activeRPC) {
      return source?.type === "pull-request"
        ? samplePullRequestRepositoryState
        : sampleRepositoryState;
    }

    return activeRPC.request.getRepositoryState({ source: source ?? { type: "working-tree" } });
  },

  async showInFolder(path) {
    const activeRPC = await getRPC();
    await activeRPC?.request.showInFolder({ path });
  },

  async openRepository(path, target) {
    const activeRPC = await getRPC();
    await activeRPC?.request.openRepository({ path, target });
  },
};

function readSourceFromLocation(): ReviewSource | undefined {
  if (typeof window === "undefined") return undefined;

  const url = new URL(window.location.href);
  const pullRequestUrl = url.searchParams.get("pr")?.trim();
  if (pullRequestUrl) {
    return { type: "pull-request", url: pullRequestUrl };
  }

  const commitRef = url.searchParams.get("commit")?.trim();
  if (commitRef) {
    return { ref: commitRef, type: "commit" };
  }

  return undefined;
}
