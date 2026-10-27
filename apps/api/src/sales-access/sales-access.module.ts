import { Module } from '@nestjs/common';

import { SalesAccessController } from './sales-access.controller';
import { SalesAccessService } from './sales-access.service';

@Module({
  controllers: [SalesAccessController],
  providers: [SalesAccessService],
})
export class SalesAccessModule {}
