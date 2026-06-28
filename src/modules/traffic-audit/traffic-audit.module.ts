import { Module } from '@nestjs/common';

import { PrismaModule } from '@common/database';

import { TrafficAuditIngestController } from './controllers/traffic-audit-ingest.controller';
import { TrafficAuditIngestTokenGuard } from './guards/traffic-audit-ingest-token.guard';
import { TrafficAuditClickhouseService } from './traffic-audit-clickhouse.service';
import { TrafficAuditController } from './controllers/traffic-audit.controller';
import { TrafficAuditService } from './traffic-audit.service';

@Module({
    imports: [PrismaModule],
    controllers: [TrafficAuditController, TrafficAuditIngestController],
    providers: [
        TrafficAuditService,
        TrafficAuditClickhouseService,
        TrafficAuditIngestTokenGuard,
    ],
})
export class TrafficAuditModule {}
