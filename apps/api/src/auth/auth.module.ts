import { PasswordSessionController } from './password-session.controller';
import { PasswordSessionService } from './password-session.service';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { WorkspaceIdentityService } from './workspace-identity.service';
import { Auth0Guard } from './auth0.guard';

@Global()
@Module({
  controllers: [PasswordSessionController],
  providers: [PasswordSessionService, Auth0Guard, WorkspaceIdentityService, { provide: APP_GUARD, useExisting: Auth0Guard }],
  exports: [Auth0Guard, WorkspaceIdentityService],
})
export class AuthModule {}
