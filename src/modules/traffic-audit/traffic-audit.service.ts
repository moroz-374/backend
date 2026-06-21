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
}
