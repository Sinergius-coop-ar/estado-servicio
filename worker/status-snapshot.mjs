import { DurableObject } from "cloudflare:workers";
import { SnapshotStore, createSnapshotWorker } from "./snapshot-handler.mjs";

export class StatusSnapshot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new SnapshotStore(ctx, env);
  }

  fetch(request) { return this.store.fetch(request); }
}

export default { fetch: createSnapshotWorker() };
