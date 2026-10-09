import { Module } from '@nestjs/common';
import { BotsModule } from '../bots/bots.module';
import { OrdersModule } from '../orders/orders.module';
import { HeartbeatMonitorService } from './heartbeat-monitor.service';

@Module({
  imports: [BotsModule, OrdersModule],
  providers: [HeartbeatMonitorService],
  exports: [HeartbeatMonitorService],
})
export class MonitorModule {}
