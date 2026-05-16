import type {
  OpenRepositoryTarget,
  RepositoryFile,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from "./repository";

export type DeltaRPCSchema = {
  bun: {
    messages: Record<never, never>;
    requests: {
      getRepositoryHistory: {
        params: { limit?: number } | undefined;
        response: RepositoryHistory;
      };
      getRepositoryState: {
        params: { source?: ReviewSource } | undefined;
        response: RepositoryState;
      };
      getRepositoryFile: {
        params: { path: string; source?: ReviewSource };
        response: RepositoryFile;
      };
      showInFolder: {
        params: { path: string };
        response: void;
      };
      openRepository: {
        params: { path: string; target: OpenRepositoryTarget };
        response: void;
      };
    };
  };
  webview: {
    messages: Record<never, never>;
    requests: Record<never, never>;
  };
};
