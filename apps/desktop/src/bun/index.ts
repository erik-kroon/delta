import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";

import type { DeltaRPCSchema } from "../../../web/src/lib/delta-rpc-schema";
import {
  listRepositoryHistory,
  openRepositoryTarget,
  readRepositoryState,
  showInRepositoryFolder,
} from "./git-state";

const DEV_SERVER_PORT = 3001;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const getLaunchPath = () => process.env.DELTA_REPOSITORY_PATH ?? process.cwd();

// Check if the web dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using web dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log('Web dev server not running. Run "bun run dev:hmr" for HMR support.');
    }
  }

  return "views://mainview/index.html";
}

const url = await getMainViewUrl();
const launchPath = getLaunchPath();
const rpc = BrowserView.defineRPC<DeltaRPCSchema>({
  handlers: {
    messages: {},
    requests: {
      getRepositoryHistory: ({ limit } = {}) => listRepositoryHistory(launchPath, limit),
      getRepositoryState: ({ source } = {}) => readRepositoryState(launchPath, source),
      showInFolder: ({ path }) =>
        showInRepositoryFolder(launchPath, path, Utils.showItemInFolder, Utils.openPath),
      openRepository: ({ path, target }) =>
        openRepositoryTarget(launchPath, path, target, Utils.showItemInFolder, Utils.openPath),
    },
  },
  maxRequestTime: Infinity,
});

new BrowserWindow({
  title: `delta - ${launchPath}`,
  url,
  rpc,
  titleBarStyle: "hiddenInset",
  trafficLightOffset: {
    x: 8,
    y: 12,
  },
  frame: {
    width: 1280,
    height: 820,
    x: 120,
    y: 120,
  },
});

console.log("Electrobun desktop shell started.");
