const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

require('reflect-metadata');

const { PATH_METADATA } = require('@nestjs/common/constants');
const { ConfigService } = require('@nestjs/config');

const {
    TrafficAuditIngestController,
} = require('../../dist/src/modules/traffic-audit/controllers/traffic-audit-ingest.controller');
const {
    TrafficAuditController,
} = require('../../dist/src/modules/traffic-audit/controllers/traffic-audit.controller');
const {
    GetFullUserResponseModel,
} = require('../../dist/src/modules/users/models/get-full-user.response.model');
const { UsersSchema } = require('../../dist/libs/contract/models/users.schema');
const {
    TrafficAuditClickhouseService,
} = require('../../dist/src/modules/traffic-audit/traffic-audit-clickhouse.service');
const {
    TrafficAuditService,
} = require('../../dist/src/modules/traffic-audit/traffic-audit.service');

test('traffic audit controllers rely on the global /api prefix exactly once', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, TrafficAuditController), 'users/:uuid/traffic-audit');
    assert.equal(Reflect.getMetadata(PATH_METADATA, TrafficAuditIngestController), 'monitoring');
});

test('the public user contract exposes the persisted audit flag', () => {
    assert.equal(UsersSchema.shape.isAuditEnabled.parse(true), true);
    assert.equal(UsersSchema.shape.isAuditEnabled.parse(undefined), false);

    const response = new GetFullUserResponseModel(
        {
            tId: 1n,
            uuid: '0b87ca01-9d3d-4aef-90b2-a6d70ca0ce51',
            shortUuid: 'short-id',
            username: 'audit-user',
            status: 'ACTIVE',
            trafficLimitBytes: 0n,
            trafficLimitStrategy: 'NO_RESET',
            isAuditEnabled: true,
            expireAt: new Date('2030-01-01T00:00:00.000Z'),
            telegramId: null,
            email: null,
            description: null,
            tag: null,
            hwidDeviceLimit: null,
            externalSquadUuid: null,
            trojanPassword: 'trojan',
            vlessUuid: 'ee88fd59-3555-4f72-9a90-e1f410ea1d94',
            ssPassword: 'shadowsocks',
            lastTriggeredThreshold: 0,
            subRevokedAt: null,
            lastTrafficResetAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            activeInternalSquads: [],
            userTraffic: {
                usedTrafficBytes: 0n,
                lifetimeUsedTrafficBytes: 0n,
                onlineAt: null,
                lastConnectedNodeUuid: null,
                firstConnectedAt: null,
            },
        },
        'panel.example.com',
    );

    assert.equal(response.isAuditEnabled, true);
});

test('ingest rejects queued events captured before audit was enabled', async () => {
    const auditEnabledAt = new Date('2026-06-27T15:00:00.000Z');
    const inserted = [];
    const service = new TrafficAuditService(
        {
            users: {
                findMany: async () => [
                    {
                        tId: 1n,
                        uuid: '0b87ca01-9d3d-4aef-90b2-a6d70ca0ce51',
                        username: 'audit-user',
                        email: null,
                        auditEnabledAt,
                    },
                ],
            },
        },
        {
            insert: async (events) => inserted.push(...events),
        },
    );

    const result = await service.ingest({
        nodeUuid: 'f817ba21-2931-41ec-a9bf-26c9543b6d77',
        events: [
            {
                eventId: randomUUID(),
                clientIdentifier: 'audit-user',
                destination: 'before.example.com',
                destinationType: 'DOMAIN',
                network: 'tcp',
                port: 443,
                requestedAt: '2026-06-27T14:59:59.999Z',
            },
            {
                eventId: randomUUID(),
                clientIdentifier: 'audit-user',
                destination: 'after.example.com',
                destinationType: 'DOMAIN',
                network: 'tcp',
                port: 443,
                requestedAt: '2026-06-27T15:00:00.000Z',
            },
        ],
    });

    assert.equal(result.received, 2);
    assert.equal(result.inserted, 1);
    assert.equal(result.discarded, 1);
    assert.equal(inserted[0].destination, 'after.example.com');
});

test(
    'ClickHouse stores, reads and expires traffic audit events',
    { skip: !process.env.CLICKHOUSE_INTEGRATION_URL },
    async () => {
        const config = new ConfigService({
            TRAFFIC_AUDIT_CLICKHOUSE_URL: process.env.CLICKHOUSE_INTEGRATION_URL,
            TRAFFIC_AUDIT_CLICKHOUSE_USER: process.env.CLICKHOUSE_INTEGRATION_USER,
            TRAFFIC_AUDIT_CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_INTEGRATION_PASSWORD,
            TRAFFIC_AUDIT_CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_INTEGRATION_DATABASE,
            TRAFFIC_AUDIT_RETENTION_DAYS: 30,
        });
        const clickhouse = new TrafficAuditClickhouseService(config);
        const eventId = randomUUID();
        const userUuid = randomUUID();

        try {
            await clickhouse.onModuleInit();
            await clickhouse.insert([
                {
                    eventId,
                    userId: 1n,
                    userUuid,
                    nodeUuid: randomUUID(),
                    destination: 'integration.example.com',
                    destinationType: 'DOMAIN',
                    network: 'tcp',
                    port: 443,
                    requestedAt: new Date(),
                    clientIdentifier: 'integration-user',
                },
            ]);

            const page = await clickhouse.getUserLogs({ userUuid, limit: 1 });

            assert.equal(page.items.length, 1);
            assert.equal(page.items[0].id, eventId);
            assert.equal(page.items[0].destination, 'integration.example.com');

            const definitionResult = await clickhouse.client.query({
                query: `SHOW CREATE TABLE traffic_logs`,
                format: 'JSONEachRow',
            });
            const [definition] = await definitionResult.json();

            assert.match(definition.statement, /TTL requested_at \+ toIntervalDay\(30\)/);
        } finally {
            await clickhouse.onModuleDestroy();
        }
    },
);
