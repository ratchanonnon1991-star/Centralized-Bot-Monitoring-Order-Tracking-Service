import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { from, mergeMap, Observable, of, throwError, catchError } from 'rxjs';
import { DbService } from '../db/db.service';

const IDEMPOTENT_KEY = 'idempotent';
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
/**
 * A key still 'processing' after this long belongs to a request whose server died mid-way
 * (no handler here runs anywhere near that long). The next request with the key takes it over
 * instead of getting 409 until the 24h expiry.
 */
const PROCESSING_STALE_SECONDS = 60;

/** JSON with object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface IdempotentOptions {
  /** When true, requests without an Idempotency-Key header are rejected. */
  required: boolean;
}

/**
 * Marks a POST handler as idempotent via the `Idempotency-Key` header.
 *
 * - First request with a key: runs the handler and stores the response.
 * - Same key + same body again: replays the stored response (header `Idempotent-Replayed: true`).
 * - Same key + different body: 422 IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first is still running: 409 IDEMPOTENCY_IN_PROGRESS (client retries later);
 *   after PROCESSING_STALE_SECONDS the first is presumed dead and the key is taken over.
 * - Handler failed with 5xx: key is released so the client can retry.
 */
export const Idempotent = (options: IdempotentOptions = { required: true }) => SetMetadata(IDEMPOTENT_KEY, options);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_KEY, ctx.getHandler());
    if (!options) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    if (!key) {
      if (!options.required) return next.handle();
      throw new BadRequestException({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' });
    }
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        error: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]',
      });
    }

    // Scope by the concrete path so one key can be reused on a different resource.
    const scope = `${req.method} ${req.path}`;
    const hash = createHash('sha256').update(canonicalJson(req.body ?? {})).digest('hex');

    // Claim the key atomically. An expired row, or one abandoned mid-request by a crashed
    // server, is taken over as if it did not exist.
    const claimed = await this.db.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT (scope, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, status = 'processing', response_status = NULL,
             response_body = NULL, created_at = now(), expires_at = now() + interval '24 hours'
         WHERE idempotency_keys.expires_at < now()
            OR (idempotency_keys.status = 'processing'
                AND idempotency_keys.created_at < now() - make_interval(secs => $4))
       RETURNING key`,
      [scope, key, hash, PROCESSING_STALE_SECONDS],
    );

    if (claimed.length === 0) {
      const [row] = await this.db.query(
        `SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      if (!row || row.status === 'processing') {
        res.setHeader('Retry-After', '1');
        throw new ConflictException({
          error: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'A request with this Idempotency-Key is still being processed',
        });
      }
      if (row.request_hash !== hash) {
        throw new UnprocessableEntityException({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used with a different request body',
        });
      }
      res.status(row.response_status);
      res.setHeader('Idempotent-Replayed', 'true');
      return of(row.response_body);
    }

    return next.handle().pipe(
      mergeMap(async (body) => {
        await this.store(scope, key, res.statusCode, body);
        return body;
      }),
      catchError((err: unknown) => {
        const settle =
          err instanceof HttpException && err.getStatus() < 500
            ? this.store(scope, key, err.getStatus(), err.getResponse())
            : this.release(scope, key);
        return from(settle).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }

  private async store(scope: string, key: string, status: number, body: unknown): Promise<void> {
    if (status >= 400) {
      // Replaying an error must reproduce it, not turn it into a 2xx.
      body = { ...(typeof body === 'object' && body !== null ? body : { message: body }), statusCode: status };
    }
    await this.db.query(
      `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4
        WHERE scope = $1 AND key = $2`,
      [scope, key, status, JSON.stringify(body ?? null)],
    );
  }

  private async release(scope: string, key: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [scope, key]);
  }
}
