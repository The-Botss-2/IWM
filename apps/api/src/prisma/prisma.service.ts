import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { prisma, rawPrisma } from '@botss/database';

/**
 * Wraps the soft-delete-extended Prisma client as a NestJS provider.
 *
 * Use `service.client.<model>.<op>(...)` for normal access (soft-delete enforced).
 * Use `service.raw.<model>.<op>(...)` for migrations or admin ops that need to
 * see/delete tombstoned rows.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client = prisma;
  readonly raw = rawPrisma;

  async onModuleInit(): Promise<void> {
    await this.raw.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.raw.$disconnect();
  }
}
