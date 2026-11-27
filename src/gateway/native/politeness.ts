import { throwIfCancelled } from "./cancel.js";

/**
 * One request at a time per host, with a pause between them. Shared by every
 * native call in the process, so two agents crawling the same site still look
 * like one polite client to it.
 */
export class HostGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastDone = new Map<string, number>();

  constructor(
    private readonly delayMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>
  ) {}

  /**
   * Run `task` once every earlier task for `host` has finished and `delayMs`
   * has passed since the last one ended. Tasks for one host run in the order
   * they were submitted; different hosts do not wait for each other. A call
   * cancelled while it waits gives up its turn without running `task`, and
   * without counting as a request the next one must pause after.
   */
  async run<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(host, tail);
    await previous;
    let ran = false;
    try {
      throwIfCancelled(signal);
      const last = this.lastDone.get(host);
      const wait = last === undefined ? 0 : last + this.delayMs - this.now();
      if (wait > 0) await this.sleep(wait);
      throwIfCancelled(signal);
      ran = true;
      return await task();
    } finally {
      if (ran) this.lastDone.set(host, this.now());
      if (this.tails.get(host) === tail) this.tails.delete(host);
      this.forgetIdleHosts();
      release();
    }
  }

  /** Keep the map from growing with every host ever visited. */
  private forgetIdleHosts(): void {
    if (this.lastDone.size < 500) return;
    const cutoff = this.now() - this.delayMs;
    for (const [host, at] of this.lastDone) {
      if (at < cutoff && !this.tails.has(host)) this.lastDone.delete(host);
    }
  }
}
