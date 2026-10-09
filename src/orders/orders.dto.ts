import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { BOT_ID_PATTERN, NoNulChars } from '../common/validation';
import { ORDER_STATUSES, OrderStatus } from './order-state';

export class CreateOrderDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_.:-]{1,64}$/, { message: 'externalOrderId must be 1-64 chars of [A-Za-z0-9_.:-]' })
  externalOrderId!: string;

  /** A top-up always costs something: 0 is a client bug, not a free order. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount!: number;

  /** ISO 4217 style code, e.g. THB (case-insensitive, stored upper-case). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter code such as THB' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulChars()
  product?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulChars()
  customerRef?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulChars()
  reason?: string;
}

export class ListOrdersQueryDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @Matches(BOT_ID_PATTERN, { message: 'botId must be 1-64 chars of [A-Za-z0-9_-]' })
  botId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  offset = 0;
}
