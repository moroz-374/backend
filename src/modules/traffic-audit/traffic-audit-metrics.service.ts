import { Injectable } from '@nestjs/common';

import { RawCacheService } from '@common/raw-cache';
import { INTERNAL_CACHE_KEYS } from '@libs/contracts/constants';

@Injectable()
export class TrafficAuditMetricsService {
    constructor(private readonly rawCacheService: RawCacheService) {}

    public async recordBatch(
        nodeUuid: string,
        counts: { received: number; accepted: number; discarded: number },
        sender: {
            queueDepth: number;
            droppedEventsTotal: number;
            retryAttemptsTotal: number;
            lastSuccessfulDeliveryAt: number | null;
        },
    ): Promise<void> {
        await this.rawCacheService.hsetJson(
            INTERNAL_CACHE_KEYS.TRAFFIC_AUDIT_SENDER_METRICS,
            nodeUuid,
            sender,
        );
    }

    public recordClickhouseError(_nodeUuid: string): void {}
}
