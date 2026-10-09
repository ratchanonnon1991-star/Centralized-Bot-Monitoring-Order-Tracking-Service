import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config';

export type AuthMode = 'public' | 'admin' | 'agent-or-admin';
const AUTH_KEY = 'auth-mode';

/** Default for every route is 'admin'; use this to relax it. */
export const Auth = (mode: AuthMode) => SetMetadata(AUTH_KEY, mode);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m ? m[1].trim() : null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const mode =
      this.reflector.getAllAndOverride<AuthMode>(AUTH_KEY, [ctx.getHandler(), ctx.getClass()]) ?? 'admin';
    if (mode === 'public') return true;

    const token = bearerToken(ctx.switchToHttp().getRequest<Request>().headers.authorization);
    if (token && safeEqual(token, this.config.adminToken)) return true;
    if (token && mode === 'agent-or-admin' && safeEqual(token, this.config.agentToken)) return true;
    throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' });
  }
}

/** Who performed an admin action, for audit logs. Taken from the X-Actor header (free text, max 64 chars). */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<Request>().headers['x-actor'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value.slice(0, 64) : 'admin';
});
