import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

export function localWorkspaceIdentity(config: ConfigService, request: Request) {
  const workspaceId = config.get<string>('LOCAL_DASHBOARD_WORKSPACE_ID');
  const userId = config.get<string>('LOCAL_DASHBOARD_USER_ID');
  const host = request.headers.host?.replace(/:\d+$/, '');
  const origin = request.headers.origin;
  if (process.env.NODE_ENV === 'production' || !workspaceId || !userId ||
      request.socket.remoteAddress !== '127.0.0.1' || !['localhost', '127.0.0.1'].includes(host ?? '') ||
      (origin && origin !== config.get<string>('WEB_ORIGIN', 'http://localhost:5173'))) {
    return undefined;
  }
  return { workspaceId, userId };
}
