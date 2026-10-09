import { Module } from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { OrderRepository } from './order.repository';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrderRepository, OrdersService, DispatchService],
  exports: [OrdersService, DispatchService],
})
export class OrdersModule {}
