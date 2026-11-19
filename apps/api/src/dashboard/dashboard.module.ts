import { Module } from '@nestjs/common';

import { LocalDashboardGuard } from '../auth/local-dashboard.guard';
import { TaskImportService } from './task-import.service';
import { TaskDetailsService } from './task-details.service';
import { TaskBoardService } from './task-board.service';
import { WorkspaceAdministrationService } from './workspace-administration.service';
import { WorkspaceUsersService } from './workspace-users.service';
import { AccountController } from './account.controller';
import { DashboardController } from './dashboard.controller';

@Module({ controllers: [DashboardController, AccountController], providers: [TaskBoardService, TaskImportService, TaskDetailsService, WorkspaceAdministrationService, WorkspaceUsersService, LocalDashboardGuard] })
export class DashboardModule {}
