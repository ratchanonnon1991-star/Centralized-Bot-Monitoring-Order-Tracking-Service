import { Module } from '@nestjs/common';
import { BotsModule } from '../bots/bots.module';
import { OrdersModule } from '../orders/orders.module';
import { AgentGateway } from './agent.gateway';
import { DashboardGateway } from './dashboard.gateway';

@Module({
  imports: [BotsModule, OrdersModule],
  providers: [AgentGateway, DashboardGateway],
})
export class RealtimeModule {}
