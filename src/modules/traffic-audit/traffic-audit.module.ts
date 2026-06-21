import { Module } from '@nestjs/common';

import { PrismaModule } from '@common/database';

import { TrafficAuditController } from './controllers/traffic-audit.controller';
import { TrafficAuditService } from './traffic-audit.service';
import { TrafficAuditIngestController } from './controllers/traffic-audit-ingest.controller';

@Module({
    imports: [PrismaModule],
    controllers: [TrafficAuditController, TrafficAuditIngestController],
    providers: [TrafficAuditService],
})
export class TrafficAuditModule {}