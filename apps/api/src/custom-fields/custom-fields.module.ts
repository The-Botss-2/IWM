import { Module } from '@nestjs/common';

import { ClientCustomFieldsController } from './client-custom-fields.controller';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';

@Module({
  controllers: [CustomFieldsController, ClientCustomFieldsController],
  providers: [CustomFieldsService],
})
export class CustomFieldsModule {}
