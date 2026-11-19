import { Body, Controller, Get, Header, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WorkspaceIdentityService } from '../auth/workspace-identity.service';
import { Public } from '../common/decorators/public.decorator';
import { WorkspaceUsersService } from './workspace-users.service';

@Public()
@Controller('account')
export class AccountController {
  constructor(
    private readonly identity: WorkspaceIdentityService,
    private readonly users: WorkspaceUsersService,
  ) {}

  @Get('profile')
  @Header('Cache-Control', 'no-store')
  async profile(@Req() request: Request) {
    const workspace = await this.identity.resolve(request);
    return { ...await this.users.accountProfile(workspace), session: workspace.session };
  }

  @Patch('profile')
  @Header('Cache-Control', 'no-store')
  async updateProfile(@Req() request: Request, @Body() body?: Record<string, unknown>) {
    const workspace = await this.identity.resolve(request);
    return { ...await this.users.updateAccountProfile(workspace, body), session: workspace.session };
  }
}
