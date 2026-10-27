import { Module } from '@nestjs/common';

import { TaskFormsController } from './task-forms.controller';
import { TaskFormsService } from './task-forms.service';

@Module({
  controllers: [TaskFormsController],
  providers: [TaskFormsService],
})
export class TaskFormsModule {}
