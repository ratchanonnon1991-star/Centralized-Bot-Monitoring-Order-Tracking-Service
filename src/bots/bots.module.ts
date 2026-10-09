import { Module } from '@nestjs/common';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';
import { CommandsService } from './commands.service';
import { SimulatorClient } from './simulator.client';

@Module({
  controllers: [BotsController],
  providers: [BotsService, CommandsService, SimulatorClient],
  exports: [BotsService, CommandsService],
})
export class BotsModule {}
