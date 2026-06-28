import { Counter, Gauge } from 'prom-client';

import { Injectable } from '@nestjs/common';

@Injectable()
export class TrafficAuditMetricsService {
    private readonly batches = new Counter({
        name: 'remnawave_traffic_audit_ingest_batches_total',
        help: 'Traffic audit ingest batches received by node',
        labelNames: ['node_uuid'] as const,
    });

    private readonly events = new Counter({
        name: 'remnawave_traffic_audit_ingest_events_total',
        help: 'Traffic audit ingest events by outcome',
        labelNames: ['node_uuid', 'outcome'] as const,
    });

    private readonly clickhouseErrors = new Counter({
        name: 'remnawave_traffic_audit_clickhouse_errors_total',
        help: 'Traffic audit ClickHouse write errors by node',
        labelNames: ['node_uuid'] as const,
    });

    private readonly queueDepth = new Gauge({
        name: 'remnawave_traffic_audit_sender_queue_depth',
        help: 'Last reported traffic audit sender queue depth',
        labelNames: ['node_uuid'] as const,
    });

    private readonly droppedEvents = new Gauge({
        name: 'remnawave_traffic_audit_sender_dropped_events_total',
        help: 'Last reported cumulative sender overflow drops',
        labelNames: ['node_uuid'] as const,
    });

    private readonly retryAttempts = new Gauge({
        name: 'remnawave_traffic_audit_sender_retry_attempts_total',
        help: 'Last reported cumulative sender retry attempts',
        labelNames: ['node_uuid'] as const,
    });

    private readonly lastSuccessfulDelivery = new Gauge({
        name: 'remnawave_traffic_audit_sender_last_success_unixtime',
        help: 'Unix time of the last successful traffic audit delivery',
        labelNames: ['node_uuid'] as const,
    });

    public recordBatch(
        nodeUuid: string,
        counts: { received: number; accepted: number; discarded: number },
        sender: {
            queueDepth: number;
            droppedEventsTotal: number;
            retryAttemptsTotal: number;
            lastSuccessfulDeliveryAt: number | null;
        },
    ): void {
        const labels = { node_uuid: nodeUuid };

        this.batches.inc(labels);
        this.events.inc({ ...labels, outcome: 'received' }, counts.received);
        this.events.inc({ ...labels, outcome: 'accepted' }, counts.accepted);
        this.events.inc({ ...labels, outcome: 'discarded' }, counts.discarded);
        this.queueDepth.set(labels, sender.queueDepth);
        this.droppedEvents.set(labels, sender.droppedEventsTotal);
        this.retryAttempts.set(labels, sender.retryAttemptsTotal);
        this.lastSuccessfulDelivery.set(labels, Date.now() / 1_000);
    }

    public recordClickhouseError(nodeUuid: string): void {
        this.clickhouseErrors.inc({ node_uuid: nodeUuid });
    }
}
