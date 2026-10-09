import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BotsModule } from './bots/bots.module';
import { AuthGuard } from './common/auth';
import { CoreModule } from './common/core.module';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { ConfigModule } from './config/app-config';
import { DbModule } from './db/db.service';
import { DeploymentsModule } from './deployments/deployments.module';
import { MonitorModule } from './monitor/monitor.module';
import { OrdersModule } from './orders/orders.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SystemController } from './system/system.controller';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    CoreModule,
    OrdersModule,
    BotsModule,
    DeploymentsModule,
    MonitorModule,
    RealtimeModule,
  ],
  controllers: [SystemController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
