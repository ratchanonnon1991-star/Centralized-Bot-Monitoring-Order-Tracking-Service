import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Actor } from '../common/auth';
import { Idempotent } from '../common/idempotency.interceptor';
import { IdParam } from '../common/validation';
import { CancelOrderDto, CreateOrderDto, ListOrdersQueryDto } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 when created, 200 when an order with this externalOrderId already existed. */
  @Post()
  @Idempotent({ required: true })
  async create(@Body() dto: CreateOrderDto, @Actor() actor: string, @Res({ passthrough: true }) res: Response) {
    const { order, created } = await this.orders.create(dto, actor);
    res.status(created ? 201 : 200);
    return { ...order, created };
  }

  @Get()
  list(@Query() q: ListOrdersQueryDto) {
    return this.orders.list(q);
  }

  @Get(':id')
  get(@IdParam() id: number) {
    return this.orders.get(id);
  }

  @Get(':id/timeline')
  timeline(@IdParam() id: number) {
    return this.orders.timeline(id);
  }

  @Post(':id/payment-confirmed')
  @HttpCode(200)
  @Idempotent({ required: false })
  confirmPayment(@IdParam() id: number, @Actor() actor: string) {
    return this.orders.confirmPayment(id, actor);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent({ required: false })
  cancel(@IdParam() id: number, @Body() dto: CancelOrderDto, @Actor() actor: string) {
    return this.orders.cancel(id, actor, dto.reason);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Idempotent({ required: false })
  retry(@IdParam() id: number, @Actor() actor: string) {
    return this.orders.retry(id, actor);
  }
}
