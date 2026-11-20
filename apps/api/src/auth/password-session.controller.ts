import { Body, Controller, Get, Header, HttpCode, NotFoundException, Patch, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PasswordSessionService } from './password-session.service';

@Public()
@Controller('session')
export class PasswordSessionController {
  constructor(private readonly sessions: PasswordSessionService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async status(@Req() request: Request) {
    if (!this.sessions.enabled) return { mode: 'disabled' };
    try {
      await this.sessions.resolve(request);
      return { mode: 'password', authenticated: true };
    } catch (error) {
      if (error instanceof UnauthorizedException) return { mode: 'password', authenticated: false };
      throw error;
    }
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  login(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body?: Record<string, unknown>) {
    if (!this.sessions.enabled) throw new NotFoundException();
    return this.sessions.login(request, response, body);
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (!this.sessions.enabled) throw new NotFoundException();
    return this.sessions.logout(request, response);
  }

  @Patch('password')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  password(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body?: Record<string, unknown>) {
    if (!this.sessions.enabled) throw new NotFoundException();
    return this.sessions.changePassword(request, response, body);
  }
}
