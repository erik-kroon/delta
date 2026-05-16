import type { DeltaRPCSchema } from "./delta-rpc-schema";
import {
  sampleRepositoryFiles,
  sampleRepositoryState,
  type OpenRepositoryTarget,
  type RepositoryFile,
  type RepositoryState,
  type ReviewSource,
} from "./repository";

type DeltaClient = {
  getRepositoryFile: (path: string, source?: ReviewSource) => Promise<RepositoryFile>;
  getRepositoryState: () => Promise<RepositoryState>;
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

  async getRepositoryState() {
    const activeRPC = await getRPC();
    if (!activeRPC) {
      return sampleRepositoryState;
    }

    return activeRPC.request.getRepositoryState({ source: { type: "working-tree" } });
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
