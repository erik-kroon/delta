import type { DeltaRPCSchema } from "./delta-rpc-schema";
import {
  sampleRepositoryState,
  type OpenRepositoryTarget,
  type RepositoryState,
} from "./repository";

type DeltaClient = {
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
