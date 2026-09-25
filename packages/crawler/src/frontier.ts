import type { Redis } from "ioredis";

/**
 * Admit a URL key atomically: returns 1 if newly admitted, 0 if already seen, -1 if the page cap
 * is reached. The seen set also holds redirect targets (added via markSeen, which does not count
 * toward the cap).
 */
const ADMIT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 0 end
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n >= tonumber(ARGV[2]) then return -1 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 1
`;

export type AdmitResult = "admitted" | "seen" | "cap-reached";

/** Per-run URL frontier state in Redis: dedupe set, admitted counter, cancel flag. */
export class Frontier {
  private readonly seenKey: string;
  private readonly admittedKey: string;
  private readonly cancelKey: string;
  private readonly finishedKey: string;

  constructor(
    private readonly redis: Redis,
    keyBase: string,
    private readonly pageCap: number,
  ) {
    this.seenKey = `${keyBase}:seen`;
    this.admittedKey = `${keyBase}:admitted`;
    this.cancelKey = `${keyBase}:cancelled`;
    this.finishedKey = `${keyBase}:finished`;
  }

  async admit(key: string): Promise<AdmitResult> {
    const r = await this.redis.eval(
      ADMIT,
      2,
      this.seenKey,
      this.admittedKey,
      key,
      String(this.pageCap),
    );
    return r === 1 ? "admitted" : r === 0 ? "seen" : "cap-reached";
  }

  /** Mark a URL as crawled without counting it toward the cap. True if it was new. */
  async markSeen(key: string): Promise<boolean> {
    return (await this.redis.sadd(this.seenKey, key)) === 1;
  }

  async admittedCount(): Promise<number> {
    return Number((await this.redis.get(this.admittedKey)) ?? 0);
  }

  /** Count one URL whose processing finished; returns the new total (survives worker restarts). */
  async incrFinished(): Promise<number> {
    return this.redis.incr(this.finishedKey);
  }

  async finishedCount(): Promise<number> {
    return Number((await this.redis.get(this.finishedKey)) ?? 0);
  }

  /** False once the run's frontier state has been cleared (or was lost). */
  async exists(): Promise<boolean> {
    return (await this.redis.exists(this.admittedKey)) === 1;
  }

  async requestCancel(): Promise<void> {
    await this.redis.set(this.cancelKey, "1");
  }

  async isCancelled(): Promise<boolean> {
    return (await this.redis.exists(this.cancelKey)) === 1;
  }

  async clear(): Promise<void> {
    await this.redis.del(this.seenKey, this.admittedKey, this.cancelKey, this.finishedKey);
  }
}
