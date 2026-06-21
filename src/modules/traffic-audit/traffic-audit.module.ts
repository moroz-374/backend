import { Module } from '@nestjs/common';

import { PrismaModule } from '@common/database';

import { TrafficAuditController } from './controllers/traffic-audit.controller';
import { TrafficAuditService } from './traffic-audit.service';
import { TrafficAuditIngestController } from './controllers/traffic-audit-ingest.controller';
import { TrafficAuditIngestTokenGuard } from './guards/traffic-audit-ingest-token.guard';

@Module({
    imports: [PrismaModule],
    controllers: [TrafficAuditController, TrafficAuditIngestController],
    providers: [TrafficAuditService, TrafficAuditIngestTokenGuard],
})
export class TrafficAuditModule {}