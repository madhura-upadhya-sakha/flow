import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Auth0Guard } from './auth0.guard';

@Global()
@Module({
  providers: [Auth0Guard, { provide: APP_GUARD, useExisting: Auth0Guard }],
  exports: [Auth0Guard],
})
export class AuthModule {}
