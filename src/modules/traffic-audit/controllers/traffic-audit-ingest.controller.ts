import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { IngestTrafficLogsDto } from '../dtos/ingest-traffic-logs.dto';
import { TrafficAuditService } from '../traffic-audit.service';

@Controller('api/monitoring')
export class TrafficAuditIngestController {
    constructor(private readonly trafficAuditService: TrafficAuditService) {}

    @Post('ingest')
    @HttpCode(HttpStatus.OK)
    public async ingest(@Body() body: IngestTrafficLogsDto) {
        return {
            response: await this.trafficAuditService.ingest(body),
        };
    }
}