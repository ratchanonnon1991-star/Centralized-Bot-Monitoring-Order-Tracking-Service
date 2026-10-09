import { Global, Module } from '@nestjs/common';
import { SystemService } from '../system/system.service';
import { AgentRegistry } from './agent-registry.service';
import { AuditService } from './audit.service';
import { EventsService } from './events.service';

/** Shared infrastructure every feature module may use. */
@Global()
@Module({
  providers: [EventsService, AgentRegistry, AuditService, SystemService],
  exports: [EventsService, AgentRegistry, AuditService, SystemService],
})
export class CoreModule {}
