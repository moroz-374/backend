import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { TrafficAuditIngestTokenGuard } from '../guards/traffic-audit-ingest-token.guard';
import { IngestTrafficLogsDto } from '../dtos/ingest-traffic-logs.dto';
import { TrafficAuditService } from '../traffic-audit.service';

@UseGuards(TrafficAuditIngestTokenGuard)
@Controller('monitoring')
export class TrafficAuditIngestController {
    constructor(private readonly trafficAuditService: TrafficAuditService) {}

    @HttpCode(HttpStatus.OK)
    @Post('ingest')
    public async ingest(@Body() body: IngestTrafficLogsDto) {
        return {
            response: await this.trafficAuditService.ingest(body),
        };
    }
}
