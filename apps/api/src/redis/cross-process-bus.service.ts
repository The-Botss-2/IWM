import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { isSplitRole, PROCESS_ROLE, type ProcessRole, servesHttp } from '../common/process-role';
import { RedisService } from './redis.service';

/**
 * One kind of event that may cross process boundaries. `decode` validates
 * (and revives, e.g. Dates) a payload received from another process; it
 * returns null to drop a malformed one.
 */
export interface BusTopic<T> {
  readonly name: string;
  decode(raw: unknown): T | null;
}

/**
 * Pub/sub channels are NOT scoped by Redis database number, unlike keys.
 * Staging shares production's Redis on another db, so the db is part of the
 * channel name; otherwise one environment's sockets would get the other's
 * events.
 */
export function busChannelPrefix(db: number | undefined): string {
  return `botss:bus:db${db ?? 0}:`;
}
const WARN_THROTTLE_MS = 60_000;

interface Envelope {
  /** Publishing process, so a process never handles its own message twice. */
  o: string;
  p: unknown;
}

/**
 * Carries in-process events (notifications, mail pushes, socket broadcasts)
 * between the `api` and `worker` processes over Redis pub/sub.
 *
 * The services that own those events keep delivering them locally exactly as
 * before and ALSO call `publish`. What the bus does depends on the role:
 *
 *   - `all`: nothing. One process holds every producer and consumer, so the
 *     in-process path is already complete; no extra Redis traffic or
 *     connection.
 *   - `worker`: publishes only. It has no sockets or SSE streams to feed.
 *   - `api`: publishes and receives. Received events are handed to the local
 *     subscribers (Socket.IO gateway, mail SSE). Its own messages are skipped
 *     by origin id, since they were already delivered locally.
 *
 * Delivery is best effort, like Socket.IO itself: a Redis hiccup drops an
 * event, never throws into the caller. The persisted rows (notifications,
 * messages, mail) stay the source of truth that clients re-fetch.
 */
@Injectable()
export class CrossProcessBus implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CrossProcessBus.name);
  private readonly origin = randomUUID();
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private subscriber: Redis | null = null;
  private bootstrapped = false;
  private lastWarnAt = 0;

  constructor(
    private readonly redis: RedisService,
    @Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all',
  ) {}

  /** Events leave this process (any split role). */
  get publishes(): boolean {
    return isSplitRole(this.role);
  }

  /** Events from other processes are delivered here (split HTTP role). */
  get receives(): boolean {
    return isSplitRole(this.role) && servesHttp(this.role);
  }

  publish<T>(topic: BusTopic<T>, payload: T): void {
    if (!this.publishes) return;
    let message: string;
    try {
      message = JSON.stringify({ o: this.origin, p: payload } satisfies Envelope);
    } catch (err) {
      this.warnThrottled(
        `Bus publish dropped topic=${topic.name}: ${(err as Error)?.message ?? 'unserializable'}`,
      );
      return;
    }
    let client: Redis;
    try {
      client = this.redis.client;
    } catch (err) {
      this.warnThrottled(
        `Bus publish dropped topic=${topic.name}: ${(err as Error)?.message ?? 'no redis'}`,
      );
      return;
    }
    // While Redis is down ioredis would park every publish in its offline
    // queue (no retry limit) and flush a burst of stale events on reconnect.
    // Best effort means dropping them instead.
    if (client.status !== 'ready') {
      this.warnThrottled(`Bus publish dropped topic=${topic.name}: Redis is ${client.status}`);
      return;
    }
    void client.publish(this.prefix(client) + topic.name, message).catch((err: unknown) => {
      this.warnThrottled(
        `Bus publish failed topic=${topic.name}: ${(err as Error)?.message ?? 'unknown'}`,
      );
    });
  }

  /**
   * Handle `topic` events published by OTHER processes. A no-op outside the
   * split `api` role. Safe to call from constructors: the Redis subscription
   * opens at application bootstrap.
   */
  subscribe<T>(topic: BusTopic<T>, handler: (payload: T) => void): () => void {
    if (!this.receives) return () => undefined;
    const wrapped = (raw: unknown): void => {
      const decoded = topic.decode(raw);
      if (decoded === null) {
        this.warnThrottled(`Bus dropped malformed payload topic=${topic.name}`);
        return;
      }
      handler(decoded);
    };
    let set = this.handlers.get(topic.name);
    const isNewTopic = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(topic.name, set);
    }
    set.add(wrapped);
    if (isNewTopic && this.subscriber) {
      void this.subscriber
        .subscribe(this.prefix(this.subscriber) + topic.name)
        .catch((err: unknown) => {
          this.warnThrottled(
            `Bus subscribe failed topic=${topic.name}: ${(err as Error)?.message ?? 'unknown'}`,
          );
        });
    }
    return () => {
      set?.delete(wrapped);
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.receives || this.bootstrapped) return;
    this.bootstrapped = true;
    // Subscriber mode takes the whole connection, so it gets its own.
    const sub = this.redis.client.duplicate();
    const prefix = this.prefix(sub);
    sub.on('error', (err: Error) => this.warnThrottled(`Bus subscriber error: ${err.message}`));
    sub.on('message', (channel: string, message: string) => this.dispatch(channel, message));
    this.subscriber = sub;
    const channels = Array.from(this.handlers.keys(), (name) => prefix + name);
    if (channels.length > 0) {
      // Not awaited: ioredis queues the command until connected and
      // re-subscribes after every reconnect; boot must not wait on Redis.
      void sub.subscribe(...channels).catch((err: unknown) => {
        this.warnThrottled(`Bus subscribe failed: ${(err as Error)?.message ?? 'unknown'}`);
      });
    }
    this.logger.log(`Cross-process event bus receiving on ${channels.length} topic(s).`);
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) await sub.quit().catch(() => undefined);
  }

  /** Exposed for the role check script. */
  dispatch(channel: string, message: string): void {
    let prefix: string;
    try {
      prefix = this.prefix(this.subscriber ?? this.redis.client);
    } catch {
      return;
    }
    if (!channel.startsWith(prefix)) return;
    const set = this.handlers.get(channel.slice(prefix.length));
    if (!set || set.size === 0) return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(message) as Envelope;
    } catch {
      this.warnThrottled(`Bus dropped unparsable message channel=${channel}`);
      return;
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.o !== 'string') return;
    if (envelope.o === this.origin) return;
    for (const handler of set) {
      try {
        handler(envelope.p);
      } catch (err) {
        this.warnThrottled(
          `Bus handler failed channel=${channel}: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
  }

  /** Exposed for the role check script. */
  get originId(): string {
    return this.origin;
  }

  private prefix(client: Redis): string {
    return busChannelPrefix(client.options.db);
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_THROTTLE_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }
}

/** Small decode helpers shared by topic definitions. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
