import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { WorkspaceIdentityService } from '../auth/workspace-identity.service';

@Injectable()
export class DashboardUploadGuard implements CanActivate {
  constructor(private readonly identity: WorkspaceIdentityService) {}

  async canActivate(context: ExecutionContext) {
    await this.identity.resolve(context.switchToHttp().getRequest<Request>());
    return true;
  }
}
