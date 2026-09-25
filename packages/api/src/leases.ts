import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Who is running what. An instance holds a lease while it runs an audit (or a policy job), so
 * two instances never run the same one, and every instance can tell that it is active.
 */
export interface Leases {
  /** Take the lease if nobody holds it; false if another holder has it. */
  acquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  /** Held by anyone (this instance included)? */
  isHeld(key: string): Promise<boolean>;
  close(): Promise<void>;
}

/** One process only (tests, a single instance). */
export class LocalLeases implements Leases {
  private readonly held = new Set<string>();

  acquire(key: string): Promise<boolean> {
    if (this.held.has(key)) return Promise.resolve(false);
    this.held.add(key);
    return Promise.resolve(true);
  }

  release(key: string): Promise<void> {
    this.held.delete(key);
    return Promise.resolve();
  }

  isHeld(key: string): Promise<boolean> {
    return Promise.resolve(this.held.has(key));
  }

  close(): Promise<void> {
    this.held.clear();
    return Promise.resolve();
  }
}

// Renew or release only a lease this instance still owns.
const RENEW = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1]) else return 0 end`;

/**
 * Leases in Redis (`<prefix>:lease:<key>` = this instance's id), expiring after `ttlMs` and
 * renewed every third of it while held. A crashed instance's leases expire, and the audit can
 * then be resumed by another.
 */
export class RedisLeases implements Leases {
  readonly owner = randomUUID();
  private readonly redis: Redis;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    redisUrl: string,
    private readonly prefix: string,
    private readonly ttlMs: number,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  private k(key: string): string {
    return `${this.prefix}:lease:${key}`;
  }

  async acquire(key: string): Promise<boolean> {
    const ok = await this.redis.set(this.k(key), this.owner, "PX", this.ttlMs, "NX");
    if (ok !== "OK") return false;
    const timer = setInterval(
      () => {
        this.redis.eval(RENEW, 1, this.k(key), this.owner, this.ttlMs).catch((e: unknown) => {
          this.onError(`lease ${key}: ${e instanceof Error ? e.message : String(e)}`);
        });
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
    timer.unref();
    this.timers.set(key, timer);
    return true;
  }

  async release(key: string): Promise<void> {
    clearInterval(this.timers.get(key));
    this.timers.delete(key);
    await this.redis.eval(RELEASE, 1, this.k(key), this.owner);
  }

  async isHeld(key: string): Promise<boolean> {
    return (await this.redis.exists(this.k(key))) === 1;
  }

  /** Stop renewing and give every lease back (a clean shutdown: others may resume at once). */
  async close(): Promise<void> {
    await Promise.all([...this.timers.keys()].map((k) => this.release(k)));
    await this.redis.quit();
  }
}
