import { ClickHouseClient, createClient } from '@clickhouse/client';

import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TTrafficAuditSettings } from '@libs/contracts/models';

interface TrafficAuditInsertEvent {
    eventId: string;
    userId: bigint;
    userUuid: string;
    nodeUuid: string;
    destination: string;
    destinationType: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';
    network: 'tcp' | 'udp';
    port: number;
    originalDestination?: string;
    originalDestinationType?: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';
    originalNetwork?: 'tcp' | 'udp';
    originalPort?: number;
    sniffedProtocol?: 'http' | 'tls' | 'quic' | 'fakedns' | 'fakedns+others';
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
                    original_destination Nullable(String) DEFAULT NULL CODEC(ZSTD(3)),
                    original_destination_type Nullable(String) DEFAULT NULL,
                    original_network Nullable(String) DEFAULT NULL,
                    original_port Nullable(UInt16) DEFAULT NULL,
                    sniffed_protocol Nullable(String) DEFAULT NULL,
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

        for (const query of [
            'ALTER TABLE traffic_logs ADD COLUMN IF NOT EXISTS original_destination Nullable(String) DEFAULT NULL CODEC(ZSTD(3)) AFTER port',
            'ALTER TABLE traffic_logs ADD COLUMN IF NOT EXISTS original_destination_type Nullable(String) DEFAULT NULL AFTER original_destination',
            'ALTER TABLE traffic_logs ADD COLUMN IF NOT EXISTS original_network Nullable(String) DEFAULT NULL AFTER original_destination_type',
            'ALTER TABLE traffic_logs ADD COLUMN IF NOT EXISTS original_port Nullable(UInt16) DEFAULT NULL AFTER original_network',
            'ALTER TABLE traffic_logs ADD COLUMN IF NOT EXISTS sniffed_protocol Nullable(String) DEFAULT NULL AFTER original_port',
        ]) {
            await this.client.command({
                query,
                clickhouse_settings: {
                    wait_end_of_query: 1,
                },
            });
        }
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
                original_destination: event.originalDestination ?? null,
                original_destination_type: event.originalDestinationType ?? null,
                original_network: event.originalNetwork ?? null,
                original_port: event.originalPort ?? null,
                sniffed_protocol: event.sniffedProtocol ?? null,
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

    public async getUserLogs(params: {
        userUuid: string;
        cursor?: string;
        limit: number;
        destination?: string;
        from?: string;
        to?: string;
        destinationType?: TrafficAuditRow['destinationType'];
        nodeUuid?: string;
        network?: TrafficAuditRow['network'];
        port?: number;
        hideRules?: TTrafficAuditSettings['hideRules'];
    }) {
        const cursor = params.cursor ? decodeCursor(params.cursor) : undefined;
        const exactRules =
            params.hideRules?.filter((rule) => rule.type === 'EXACT').map((rule) => rule.pattern) ??
            [];
        const suffixRules =
            params.hideRules
                ?.filter((rule) => rule.type === 'SUFFIX')
                .map((rule) => rule.pattern) ?? [];
        const globRules =
            params.hideRules
                ?.filter((rule) => rule.type === 'GLOB')
                .map((rule) => globToRegex(rule.pattern)) ?? [];
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
                  AND ({hasDestination:UInt8} = 0 OR position(destination, {destination:String}) > 0)
                  AND ({hasFrom:UInt8} = 0 OR requested_at >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC'))
                  AND ({hasTo:UInt8} = 0 OR requested_at <= fromUnixTimestamp64Milli({toMs:Int64}, 'UTC'))
                  AND ({hasDestinationType:UInt8} = 0 OR destination_type = {destinationType:String})
                  AND ({hasNodeUuid:UInt8} = 0 OR node_uuid = {nodeUuid:UUID})
                  AND ({hasNetwork:UInt8} = 0 OR network = {network:String})
                  AND ({hasPort:UInt8} = 0 OR port = {port:UInt16})
                  AND NOT has({hideExact:Array(String)}, destination)
                  AND NOT arrayExists(
                    suffix -> destination = suffix OR endsWith(destination, concat('.', suffix)),
                    {hideSuffix:Array(String)}
                  )
                  AND NOT arrayExists(regex -> match(destination, regex), {hideGlob:Array(String)})
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
                hasDestination: params.destination ? 1 : 0,
                destination: params.destination ?? '',
                hasFrom: params.from ? 1 : 0,
                fromMs: params.from ? String(Date.parse(params.from)) : '0',
                hasTo: params.to ? 1 : 0,
                toMs: params.to ? String(Date.parse(params.to)) : '0',
                hasDestinationType: params.destinationType ? 1 : 0,
                destinationType: params.destinationType ?? 'UNKNOWN',
                hasNodeUuid: params.nodeUuid ? 1 : 0,
                nodeUuid: params.nodeUuid ?? '00000000-0000-0000-0000-000000000000',
                hasNetwork: params.network ? 1 : 0,
                network: params.network ?? 'tcp',
                hasPort: params.port ? 1 : 0,
                port: params.port ?? 1,
                hideExact: exactRules,
                hideSuffix: suffixRules,
                hideGlob: globRules,
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

export function globToRegex(glob: string): string {
    let result = '^';

    for (const character of glob) {
        if (character === '*') {
            result += '.*';
        } else if (character === '?') {
            result += '.';
        } else {
            result += character.replace(/[\\^$+.[\]{}()|]/g, '\\$&');
        }
    }

    return `${result}$`;
}

function encodeCursor(cursor: TrafficAuditCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string): TrafficAuditCursor {
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
