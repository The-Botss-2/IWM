import { Module } from '@nestjs/common';

import { FinanceModule } from '../finance/finance.module';

import { ScopeModule } from '../common/scope/scope.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [FinanceModule, ScopeModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
