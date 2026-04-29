export interface HarnessRuntime {
  restartServer: () => Promise<void>;
  stopServer: () => Promise<void>;
}
