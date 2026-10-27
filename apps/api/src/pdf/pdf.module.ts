import { Module } from '@nestjs/common';

import { GotenbergClient } from './gotenberg.client';

/** HTML to PDF rendering, shared by invoices and signature requests. */
@Module({
  providers: [GotenbergClient],
  exports: [GotenbergClient],
})
export class PdfModule {}
