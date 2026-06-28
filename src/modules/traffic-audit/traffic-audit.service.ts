import {Injectable, NotFoundException} from '@nestjs/common';

import {PrismaService} from '@common/database/prisma.service';

import { TrafficAuditClickhouseService } from './traffic-audit-clickhouse.service';
import { IngestTrafficLogsDto } from './dtos/ingest-traffic-logs.dto';

@Injectable()
export class TrafficAuditService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly clickhouse: TrafficAuditClickhouseService,
    ) {}

    public async updateAuditFlag(userUuid: string, enabled: boolean) {
        const user = await this.prisma.users.findUnique({
            where: {
                uuid: userUuid,
            },
            select: {
                uuid: true,
                isAuditEnabled: true,
                auditEnabledAt: true,
            },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        if (user.isAuditEnabled === enabled) {
            return {
                uuid: user.uuid,
                isAuditEnabled: user.isAuditEnabled,
            };
        }

        return this.prisma.users.update({
            where: {
                uuid: userUuid,
            },
            data: {
                isAuditEnabled: enabled,
                auditEnabledAt: enabled ? new Date() : null,
            },
            select: {
                uuid: true,
                isAuditEnabled: true,
            },
        });
    }

    public async getUserLogs(userUuid: string, params: { cursor?: string; limit: number }) {
        return this.clickhouse.getUserLogs({ userUuid, ...params });
    }

    public async ingest(body: IngestTrafficLogsDto) {
        const identifiers = [...new Set(body.events.map((event) => event.clientIdentifier))];

        const auditedUsers = await this.prisma.users.findMany({
            where: {
                isAuditEnabled: true,
                OR: [
                    {
                        email: {
                            in: identifiers,
                        },
                    },
                    {
                        username: {
                            in: identifiers,
                        },
                    },
                    {
                        uuid: {
                            in: identifiers,
                        },
                    },
                ],
            },
            select: {
                tId: true,
                email: true,
                username: true,
                uuid: true,
                auditEnabledAt: true,
            },
        });

        const identifierToUser = new Map<
            string,
            { auditEnabledAt: Date | null; tId: bigint; uuid: string }
        >();

        for (const user of auditedUsers) {
            if (user.email) {
                identifierToUser.set(user.email, user);
            }

            identifierToUser.set(user.username, user);
            identifierToUser.set(user.uuid, user);
        }

        const logsToInsert = body.events.flatMap((event) => {
            const user = identifierToUser.get(event.clientIdentifier);

            if (
                !user ||
                !user.auditEnabledAt ||
                new Date(event.requestedAt) < user.auditEnabledAt
            ) {
                return [];
            }

            return [
                {
                    eventId: event.eventId,
                    userId: user.tId,
                    userUuid: user.uuid,
                    nodeUuid: body.nodeUuid,
                    destination: event.destination.trim().toLowerCase().replace(/\.$/, ''),
                    destinationType: event.destinationType,
                    network: event.network,
                    port: event.port,
                    requestedAt: new Date(event.requestedAt),
                    clientIdentifier: event.clientIdentifier,
                },
            ];
        });

        await this.clickhouse.insert(logsToInsert);

        return {
            received: body.events.length,
            accepted: logsToInsert.length,
            inserted: logsToInsert.length,
            discarded: body.events.length - logsToInsert.length,
        };
    }
}
