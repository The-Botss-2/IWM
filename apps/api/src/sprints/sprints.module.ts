import { Module } from '@nestjs/common';

import { FinanceModule } from '../finance/finance.module';

import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';

@Module({
  imports: [FinanceModule],
  controllers: [SprintsController],
  providers: [SprintsService],
})
export class SprintsModule {}
