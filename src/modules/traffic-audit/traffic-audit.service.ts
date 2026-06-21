import {Injectable, NotFoundException} from '@nestjs/common';

import {PrismaService} from '@common/database/prisma.service';

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

}
