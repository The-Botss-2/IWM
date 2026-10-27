import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatFanoutProcessor } from './chat-fanout.processor';
import { CHAT_FANOUT_QUEUE } from './chat-fanout.queue';
import { ChatRequestsController } from './chat-requests.controller';
import { ChatRequestsService } from './chat-requests.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    AdminModule,
    BullModule.registerQueue({ name: CHAT_FANOUT_QUEUE }),
  ],
  controllers: [ChatController, ChatRequestsController],
  providers: [ChatService, ChatRequestsService, ChatGateway, ChatFanoutProcessor],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
