import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';

import { Roles } from '@common/decorators/roles/roles';
import { JwtDefaultGuard } from '@common/guards/jwt-guards/def-jwt-guard';
import { RolesGuard } from '@common/guards/roles';
import { ROLE } from '@libs/contracts/constants';

import { UpdateTrafficAuditDto } from '../dtos/update-traffic-audit.dto';
import { TrafficAuditService } from '../traffic-audit.service';
import { GetTrafficLogsDto } from '../dtos/get-traffic-logs.dto';

@Roles(ROLE.ADMIN, ROLE.API)
@UseGuards(JwtDefaultGuard, RolesGuard)
@Controller('api/users/:uuid/traffic-audit')
export class TrafficAuditController {
    constructor(private readonly trafficAuditService: TrafficAuditService) {}

    @Patch()
    public async updateFlag(@Param('uuid') userUuid: string, @Body() body: UpdateTrafficAuditDto) {
        return {
            response: await this.trafficAuditService.updateAuditFlag(userUuid, body.enabled),
        };
    }

    @Get('logs')
    public async getLogs(@Param('uuid') userUuid: string, @Query() query: GetTrafficLogsDto) {
        return {
            response: await this.trafficAuditService.getUserLogs(userUuid, query),
        };
    }

}