import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { IS_PUBLIC_ROUTE } from '../common/decorators/public.decorator';

type AuthenticatedRequest = Request & { auth?: { subject: string; claims: JWTPayload } };

@Injectable()
export class Auth0Guard implements CanActivate {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const issuerValue = this.config.get<string>('AUTH0_ISSUER');
    const audience = this.config.get<string>('AUTH0_AUDIENCE');
    if (!issuerValue || !audience || issuerValue.includes('YOUR_TENANT')) {
      throw new InternalServerErrorException('Authentication is not configured.');
    }

    const issuer = issuerValue.endsWith('/') ? issuerValue : `${issuerValue}/`;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('A valid bearer token is required.');

    try {
      this.jwks ??= createRemoteJWKSet(new URL('.well-known/jwks.json', issuer));
      const { payload } = await jwtVerify(token, this.jwks, { issuer, audience });
      if (!payload.sub) throw new UnauthorizedException('Token subject is missing.');
      request.auth = { subject: payload.sub, claims: payload };
      return true;
    } catch {
      throw new UnauthorizedException('The access token is invalid or expired.');
    }
  }
}
