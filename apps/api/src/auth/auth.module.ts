import { Global, Module } from '@nestjs/common';

import { AuthContextCache } from './auth-context-cache';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  providers: [AuthService, AuthContextCache],
  controllers: [AuthController],
  exports: [AuthService, AuthContextCache],
})
export class AuthModule {}
