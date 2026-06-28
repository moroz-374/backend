import { Module } from '@nestjs/common';

import { PrismaModule } from '@common/database';

import { TrafficAuditCredentialService } from './traffic-audit-credential.service';

@Module({
    imports: [PrismaModule],
    providers: [TrafficAuditCredentialService],
    exports: [TrafficAuditCredentialService],
})
export class TrafficAuditCredentialModule {}
