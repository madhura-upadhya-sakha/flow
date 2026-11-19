import { Injectable, NotFoundException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { localWorkspaceIdentity } from './local-workspace';

@Injectable()
export class LocalDashboardGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    if (!localWorkspaceIdentity(this.config, context.switchToHttp().getRequest<Request>())) {
      throw new NotFoundException();
    }
    return true;
  }
}
