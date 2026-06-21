import {Injectable, NotFoundException} from '@nestjs/common';

import {PrismaService} from '@common/database/prisma.service';
import { IngestTrafficLogsDto } from './dtos/ingest-traffic-logs.dto';

@Injectable()
export class TrafficAuditService {
    constructor(private readonly prisma: PrismaService) {
    }

    public async updateAuditFlag(userUuid: string, enabled: boolean) {
        try {
            return await this.prisma.users.update({
                where: {
                    uuid: userUuid,
                },
                data: {
                    isAuditEnabled: enabled,
                },
                select: {
                    uuid: true,
                    isAuditEnabled: true,
                },
            });
        } catch {
            throw new NotFoundException('User not found');
        }
    }

    public async getUserLogs(userUuid: string, params: { cursor?: string; limit: number }) {
        const cursor = params.cursor ? BigInt(params.cursor) : undefined;

        const rows = await this.prisma.trafficLog.findMany({
            where: {
                user: {
                    uuid: userUuid,
                },
            },
            orderBy: {
                id: 'desc',
            },
            take: params.limit + 1,
            ...(cursor
                ? {
                    cursor: {
                        id: cursor,
                    },
                    skip: 1,
                }
                : {}),
            select: {
                id: true,
                destination: true,
                destinationType: true,
                network: true,
                port: true,
                requestedAt: true,
                nodeUuid: true,
            },
        });

        const hasMore = rows.length > params.limit;
        const items = hasMore ? rows.slice(0, params.limit) : rows;
        const lastItem = items.at(-1);

        return {
            items: items.map((item) => ({
                ...item,
                id: item.id.toString(),
            })),
            nextCursor: hasMore && lastItem ? lastItem.id.toString() : null,
        };
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
            },
        });

        const identifierToUserId = new Map<string, bigint>();

        for (const user of auditedUsers) {
            if (user.email) {
                identifierToUserId.set(user.email, user.tId);
            }

            identifierToUserId.set(user.username, user.tId);
            identifierToUserId.set(user.uuid, user.tId);
        }

        const logsToInsert = body.events.flatMap((event) => {
            const userId = identifierToUserId.get(event.clientIdentifier);

            if (!userId) {
                return [];
            }

            return [
                {
                    eventId: event.eventId,
                    userId,
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

        const result = await this.prisma.trafficLog.createMany({
            data: logsToInsert,
            skipDuplicates: true,
        });

        return {
            received: body.events.length,
            accepted: logsToInsert.length,
            inserted: result.count,
            discarded: body.events.length - logsToInsert.length,
        };
    }
}
