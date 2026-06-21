import { Module } from '@nestjs/common';

import { PrismaModule } from '@common/database';

import { TrafficAuditController } from './controllers/traffic-audit.controller';
import { TrafficAuditService } from './traffic-audit.service';

@Module({
    imports: [PrismaModule],
    controllers: [TrafficAuditController],
    providers: [TrafficAuditService],
})
export class TrafficAuditModule {}