import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AdminModule } from '../admin/admin.module';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SupportFileLinksInterceptor } from './support-file-links.interceptor';
import { SupportSessionService } from './support-session.service';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/**
 * Support access (grants + read only support sessions). Exports
 * `SupportSessionService` for the global AuthGuard, which runs every request
 * that carries a support token through it, and installs the global
 * interceptor that points a support session's file links at the guarded
 * content route (a no-op for every other request).
 */
@Module({
  imports: [PrismaModule, AdminModule, FilesModule],
  controllers: [SupportController],
  providers: [
    SupportService,
    SupportSessionService,
    GlobalAdminGuard,
    { provide: APP_INTERCEPTOR, useClass: SupportFileLinksInterceptor },
  ],
  exports: [SupportSessionService],
})
export class SupportModule {}
