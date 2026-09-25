import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { PipelineEvent } from "./pipeline.js";

export type EventListener = (e: PipelineEvent) => void;

/** Where pipeline events go: every API instance's SSE streams see every instance's events. */
export interface EventBus {
  publish(e: PipelineEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Resolves once subscriptions receive events (read state after this, so nothing is missed). */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** One process only (tests, a single instance without Redis). */
export class LocalEventBus implements EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(e: PipelineEvent): void {
    this.emitter.emit("event", e);
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.emitter.removeAllListeners();
    return Promise.resolve();
  }
}

/**
 * Redis pub/sub on `<prefix>:audit-events`. Events are delivered to local subscribers only
 * through Redis (also the publisher's own), so every instance sees them in the same order.
 * The subscriber connection is opened on the first subscription.
 */
export class RedisEventBus implements EventBus {
  readonly channel: string;
  private readonly pub: Redis;
  private sub: Redis | null = null;
  private subscribed: Promise<unknown> | null = null;
  private readonly local = new LocalEventBus();

  constructor(
    private readonly redisUrl: string,
    prefix: string,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.channel = `${prefix}:audit-events`;
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  publish(e: PipelineEvent): void {
    this.pub.publish(this.channel, JSON.stringify(e)).catch((err: unknown) => {
      this.onError(`event bus: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  subscribe(listener: EventListener): () => void {
    void this.ready().catch(() => undefined);
    return this.local.subscribe(listener);
  }

  /** Opens the subscriber connection once; events published before it is active are not seen. */
  async ready(): Promise<void> {
    if (this.subscribed === null) {
      const sub = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      sub.on("message", (_channel: string, message: string) => {
        try {
          this.local.publish(JSON.parse(message) as PipelineEvent);
        } catch {
          this.onError(`event bus: unreadable message ${message.slice(0, 100)}`);
        }
      });
      this.sub = sub;
      this.subscribed = sub.subscribe(this.channel);
    }
    await this.subscribed;
  }

  async close(): Promise<void> {
    await this.local.close();
    await Promise.all([this.pub.quit(), this.sub?.quit()]);
  }
}
