import { Module } from '@nestjs/common';

import { ScopeModule } from '../common/scope/scope.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

@Module({
  imports: [PrismaModule, ScopeModule],
  controllers: [TodosController],
  providers: [TodosService],
  exports: [TodosService],
})
export class TodosModule {}
