import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

import { JwtDefaultGuard } from '@common/guards/jwt-guards/def-jwt-guard';
import { Roles } from '@common/decorators/roles/roles';
import { RolesGuard } from '@common/guards/roles';
import { ROLE } from '@libs/contracts/constants';

import { UpdateTrafficAuditDto } from '../dtos/update-traffic-audit.dto';
import { GetTrafficLogsDto, GetTrafficLogsResponseDto } from '../dtos/get-traffic-logs.dto';
import { TrafficAuditService } from '../traffic-audit.service';

@Roles(ROLE.ADMIN, ROLE.API)
@UseGuards(JwtDefaultGuard, RolesGuard)
@Controller('users/:uuid/traffic-audit')
export class TrafficAuditController {
    constructor(private readonly trafficAuditService: TrafficAuditService) {}

    @Patch()
    public async updateFlag(@Param('uuid') userUuid: string, @Body() body: UpdateTrafficAuditDto) {
        return {
            response: await this.trafficAuditService.updateAuditFlag(userUuid, body.enabled),
        };
    }

    @Get('logs')
    @ApiOkResponse({
        type: GetTrafficLogsResponseDto,
        description: 'Traffic audit logs fetched',
    })
    public async getLogs(
        @Param('uuid') userUuid: string,
        @Query() query: GetTrafficLogsDto,
    ): Promise<GetTrafficLogsResponseDto> {
        return {
            response: await this.trafficAuditService.getUserLogs(userUuid, query),
        };
    }

}
