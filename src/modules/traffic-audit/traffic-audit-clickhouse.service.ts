import { ClickHouseClient, createClient } from '@clickhouse/client';

import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TrafficAuditInsertEvent {
    eventId: string;
    userId: bigint;
    userUuid: string;
    nodeUuid: string;
    destination: string;
    destinationType: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';
    network: 'tcp' | 'udp';
    port: number;
    requestedAt: Date;
    clientIdentifier: string;
}

export interface TrafficAuditRow {
    id: string;
    destination: string;
    destinationType: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';
    network: 'tcp' | 'udp';
    nodeUuid: string;
    port: number;
    requestedAtMs: string;
}

interface TrafficAuditCursor {
    eventId: string;
    requestedAtMs: string;
}

@Injectable()
export class TrafficAuditClickhouseService implements OnModuleDestroy, OnModuleInit {
    private readonly client: ClickHouseClient;
    private readonly retentionDays: number;

    constructor(configService: ConfigService) {
        this.retentionDays = configService.getOrThrow<number>('TRAFFIC_AUDIT_RETENTION_DAYS');
        this.client = createClient({
            url: configService.getOrThrow<string>('TRAFFIC_AUDIT_CLICKHOUSE_URL'),
            username: configService.getOrThrow<string>('TRAFFIC_AUDIT_CLICKHOUSE_USER'),
            password: configService.getOrThrow<string>('TRAFFIC_AUDIT_CLICKHOUSE_PASSWORD'),
            database: configService.getOrThrow<string>('TRAFFIC_AUDIT_CLICKHOUSE_DATABASE'),
            request_timeout: 10_000,
            compression: {
                request: true,
                response: true,
            },
        });
    }

    public async onModuleInit(): Promise<void> {
        await this.client.command({
            query: `
                CREATE TABLE IF NOT EXISTS traffic_logs
                (
                    event_id UUID,
                    user_id UInt64,
                    user_uuid UUID,
                    node_uuid UUID,
                    destination String CODEC(ZSTD(3)),
                    destination_type LowCardinality(String),
                    network LowCardinality(String),
                    port UInt16,
                    requested_at DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(1)),
                    client_identifier String CODEC(ZSTD(3)),
                    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
                )
                ENGINE = ReplacingMergeTree(created_at)
                PARTITION BY toYYYYMM(requested_at)
                ORDER BY (user_uuid, requested_at, event_id)
                TTL requested_at + INTERVAL ${this.retentionDays} DAY DELETE
            `,
            clickhouse_settings: {
                wait_end_of_query: 1,
            },
        });
    }

    public async onModuleDestroy(): Promise<void> {
        await this.client.close();
    }

    public async insert(events: TrafficAuditInsertEvent[]): Promise<void> {
        if (events.length === 0) {
            return;
        }

        await this.client.insert({
            table: 'traffic_logs',
            values: events.map((event) => ({
                event_id: event.eventId,
                user_id: event.userId.toString(),
                user_uuid: event.userUuid,
                node_uuid: event.nodeUuid,
                destination: event.destination,
                destination_type: event.destinationType,
                network: event.network,
                port: event.port,
                requested_at: event.requestedAt.toISOString(),
                client_identifier: event.clientIdentifier,
            })),
            format: 'JSONEachRow',
            clickhouse_settings: {
                date_time_input_format: 'best_effort',
                wait_end_of_query: 1,
            },
        });
    }

    public async getUserLogs(params: { userUuid: string; cursor?: string; limit: number }) {
        const cursor = params.cursor ? decodeCursor(params.cursor) : undefined;
        const result = await this.client.query({
            query: `
                SELECT
                    toString(event_id) AS id,
                    destination,
                    destination_type AS destinationType,
                    network,
                    port,
                    toString(toUnixTimestamp64Milli(requested_at)) AS requestedAtMs,
                    toString(node_uuid) AS nodeUuid
                FROM traffic_logs FINAL
                WHERE user_uuid = {userUuid:UUID}
                  AND (
                    {hasCursor:UInt8} = 0
                    OR (requested_at, event_id) < (
                        fromUnixTimestamp64Milli({cursorRequestedAtMs:Int64}, 'UTC'),
                        {cursorEventId:UUID}
                    )
                  )
                ORDER BY requested_at DESC, event_id DESC
                LIMIT {limit:UInt32}
            `,
            query_params: {
                userUuid: params.userUuid,
                hasCursor: cursor ? 1 : 0,
                cursorRequestedAtMs: cursor?.requestedAtMs ?? '0',
                cursorEventId: cursor?.eventId ?? '00000000-0000-0000-0000-000000000000',
                limit: params.limit + 1,
            },
            format: 'JSONEachRow',
        });
        const rows = await result.json<TrafficAuditRow>();
        const hasMore = rows.length > params.limit;
        const items = hasMore ? rows.slice(0, params.limit) : rows;
        const lastItem = items.at(-1);

        return {
            items: items.map(({ requestedAtMs, ...item }) => ({
                ...item,
                requestedAt: new Date(Number(requestedAtMs)).toISOString(),
            })),
            nextCursor:
                hasMore && lastItem
                    ? encodeCursor({
                        eventId: lastItem.id,
                        requestedAtMs: lastItem.requestedAtMs,
                    })
                    : null,
        };
    }
}

function encodeCursor(cursor: TrafficAuditCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): TrafficAuditCursor {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

        if (
            !parsed ||
            typeof parsed !== 'object' ||
            !('eventId' in parsed) ||
            typeof parsed.eventId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                parsed.eventId,
            ) ||
            !('requestedAtMs' in parsed) ||
            typeof parsed.requestedAtMs !== 'string' ||
            !/^\d+$/.test(parsed.requestedAtMs)
        ) {
            throw new Error('Invalid cursor shape');
        }

        return {
            eventId: parsed.eventId,
            requestedAtMs: parsed.requestedAtMs,
        };
    } catch {
        throw new BadRequestException('Invalid traffic audit cursor');
    }
}
