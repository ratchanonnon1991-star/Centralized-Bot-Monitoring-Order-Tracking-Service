import { BadRequestException, createParamDecorator, ExecutionContext, Injectable, PipeTransform } from '@nestjs/common';
import { Matches, ValidationOptions } from 'class-validator';
import type { Request } from 'express';

/** Bot ids: same rule for REST params, query filters and the agent WebSocket. */
export const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Numeric resource id (orders, deployments). ParseIntPipe accepts values beyond BIGINT,
 * which PostgreSQL then rejects with a 500; this stays within safe integers and says 400.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const n = /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n)) {
      throw new BadRequestException({ error: 'INVALID_ID', message: 'id must be a positive integer' });
    }
    return n;
  }
}

@Injectable()
export class BotIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!BOT_ID_PATTERN.test(value)) {
      throw new BadRequestException({ error: 'INVALID_BOT_ID', message: 'bot id must be 1-64 chars of [A-Za-z0-9_-]' });
    }
    return value;
  }
}

/**
 * The raw route parameter string. With @Param the global ValidationPipe (transform: true) has
 * already turned "1e3" into 1000 and "007" into 7 before our pipe could reject them.
 */
const RawParam = createParamDecorator((name: string, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().params[name];
  return Array.isArray(value) ? value.join('/') : value; // arrays only come from wildcard routes
});

/** Numeric id route parameter, validated by ParseIdPipe. */
export const IdParam = (name = 'id') => RawParam(name, ParseIdPipe);

/** Bot id route parameter, validated by BotIdPipe. */
export const BotIdParam = (name = 'id') => RawParam(name, BotIdPipe);

/** PostgreSQL TEXT cannot store U+0000; reject it at the edge instead of failing with a 500. */
export const NoNulChars = (options?: ValidationOptions) =>
  Matches(/^[^\u0000]*$/, { message: '$property must not contain NUL characters', ...options });

/** Removes U+0000 from every string in a JSON-like value (TEXT and JSONB both reject it). */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000/g, '') as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripNul(k), stripNul(v)])) as T;
  }
  return value;
}
