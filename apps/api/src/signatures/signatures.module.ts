import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { FilesModule } from '../files/files.module';
import { PdfModule } from '../pdf/pdf.module';
import { ClientSignaturesController } from './client-signatures.controller';
import { PublicSignaturesController } from './public-signatures.controller';
import { SignaturePdfService } from './signature-pdf.service';
import { SignatureSealProcessor } from './signature-seal.processor';
import { SIGNATURES_QUEUE } from './signature.queue';
import { SignaturesController } from './signatures.controller';
import { SignaturesService } from './signatures.service';

/**
 * E-signature: freeze a document or an uploaded PDF, collect signatures
 * through login-free links, then seal the result with a certificate page.
 * Prisma, Redis, email and notifications are global modules.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: SIGNATURES_QUEUE }),
    DocumentsModule,
    FilesModule,
    PdfModule,
  ],
  controllers: [SignaturesController, PublicSignaturesController, ClientSignaturesController],
  providers: [SignaturesService, SignaturePdfService, SignatureSealProcessor],
  // The client portal signs through the same service (portal/portal-signatures).
  exports: [SignaturesService],
})
export class SignaturesModule {}
