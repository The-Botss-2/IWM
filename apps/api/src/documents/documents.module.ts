import { Module } from '@nestjs/common';

import { ClientDocumentsController } from './client-documents.controller';
import { ClientDocumentsService } from './client-documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PublicDocumentsController } from './public-documents.controller';

@Module({
  controllers: [DocumentsController, PublicDocumentsController, ClientDocumentsController],
  providers: [DocumentsService, ClientDocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
