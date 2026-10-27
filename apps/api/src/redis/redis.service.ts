import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private _client?: Redis;

  constructor(private readonly configService: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const url = this.configService?.get('REDIS_URL') ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

    this._client = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    this._client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  get client(): Redis {
    if (!this._client) {
      throw new Error('RedisService accessed before initialization');
    }
    return this._client;
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.quit();
  }
}
