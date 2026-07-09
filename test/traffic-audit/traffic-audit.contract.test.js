const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
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
const {
    getTrafficLogsSchema,
    getTrafficLogsResponseSchema,
} = require('../../dist/src/modules/traffic-audit/dtos/get-traffic-logs.dto');
const {
    TrafficAuditSettingsSchema,
} = require('../../dist/libs/contract/models/remnawave-settings/traffic-audit-settings.schema');
const {
    decodeCursor,
    globToRegex,
} = require('../../dist/src/modules/traffic-audit/traffic-audit-clickhouse.service');
const {
    ingestTrafficLogsSchema,
} = require('../../dist/src/modules/traffic-audit/dtos/ingest-traffic-logs.dto');
const { GetPubKeyCommand } = require('../../dist/libs/contract/commands/keygen/get-pubkey.command');
const { CreateNodeCommand } = require('../../dist/libs/contract/commands/nodes/create.command');
const {
    TrafficAuditCredentialService,
} = require('../../dist/src/modules/traffic-audit/credentials/traffic-audit-credential.service');

test('traffic audit controllers rely on the global /api prefix exactly once', () => {
    assert.equal(
        Reflect.getMetadata(PATH_METADATA, TrafficAuditController),
        'users/:uuid/traffic-audit',
    );
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
    let userQuery;
    const service = new TrafficAuditService(
        {
            users: {
                findMany: async (query) => {
                    userQuery = query;
                    return [
                        {
                            tId: 1n,
                            uuid: '0b87ca01-9d3d-4aef-90b2-a6d70ca0ce51',
                            username: 'audit-user',
                            email: null,
                            auditEnabledAt,
                        },
                    ];
                },
            },
        },
        {
            insert: async (events) => inserted.push(...events),
        },
        {
            recordBatch() {},
            recordClickhouseError() {},
        },
    );

    const result = await service.ingest('f817ba21-2931-41ec-a9bf-26c9543b6d77', {
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
                originalDestination: '203.0.113.20',
                originalDestinationType: 'IPV4',
                originalNetwork: 'tcp',
                originalPort: 443,
                sniffedProtocol: 'tls',
                requestedAt: '2026-06-27T15:00:00.000Z',
            },
        ],
        metrics: {
            queueDepth: 0,
            droppedEventsTotal: 0,
            retryAttemptsTotal: 0,
            lastSuccessfulDeliveryAt: null,
        },
    });

    assert.equal(result.received, 2);
    assert.equal(result.inserted, 1);
    assert.equal(result.discarded, 1);
    assert.equal(inserted[0].destination, 'after.example.com');
    assert.equal(inserted[0].originalDestination, '203.0.113.20');
    assert.equal(inserted[0].originalDestinationType, 'IPV4');
    assert.equal(inserted[0].originalNetwork, 'tcp');
    assert.equal(inserted[0].originalPort, 443);
    assert.equal(inserted[0].sniffedProtocol, 'tls');
    assert.equal(userQuery.where.OR.some((condition) => condition.uuid), false);
});

test('traffic log filters reject malformed cursors and invalid bounds', () => {
    assert.equal(getTrafficLogsSchema.safeParse({ cursor: '', limit: 10 }).success, false);
    assert.equal(getTrafficLogsSchema.safeParse({ port: 0 }).success, false);
    assert.equal(
        getTrafficLogsSchema.safeParse({
            from: '2026-06-29T00:00:00.000Z',
            to: '2026-06-28T00:00:00.000Z',
        }).success,
        false,
    );
    assert.throws(() => decodeCursor('not-a-valid-cursor'), /Invalid traffic audit cursor/);
});

test('node provisioning contracts require a one-time traffic audit credential', () => {
    assert.equal(
        GetPubKeyCommand.ResponseSchema.safeParse({ response: { pubKey: 'secret-key' } }).success,
        false,
    );
    assert.equal(
        CreateNodeCommand.RequestSchema.shape.trafficAuditCredential.safeParse(
            `${'a'.repeat(24)}.${'b'.repeat(43)}`,
        ).success,
        true,
    );
    const ingest = ingestTrafficLogsSchema.safeParse({
        nodeUuid: randomUUID(),
        events: [],
        metrics: {},
    });
    assert.equal(ingest.success, false);
    assert.equal('nodeUuid' in ingestTrafficLogsSchema.shape, false);
});

test('ingest payload schema accepts old and versioned extended traffic audit events', () => {
    const oldPayload = ingestTrafficLogsSchema.parse({
        events: [
            {
                eventId: randomUUID(),
                clientIdentifier: 'audit-user',
                destination: 'Legacy.Example.COM.',
                destinationType: 'DOMAIN',
                network: 'tcp',
                port: 443,
                requestedAt: '2026-07-08T12:00:00.000Z',
            },
        ],
        metrics: {
            queueDepth: 0,
            droppedEventsTotal: 0,
            retryAttemptsTotal: 0,
            lastSuccessfulDeliveryAt: null,
        },
    });

    assert.equal(oldPayload.schemaVersion, 1);
    assert.equal(oldPayload.events[0].destination, 'legacy.example.com');

    const extendedPayload = ingestTrafficLogsSchema.parse({
        schemaVersion: 2,
        events: [
            {
                eventId: randomUUID(),
                clientIdentifier: 'audit-user',
                destination: 'Sniffed.Example.COM.',
                destinationType: 'DOMAIN',
                network: 'udp',
                port: 443,
                originalDestination: '203.0.113.20',
                originalDestinationType: 'IPV4',
                originalNetwork: 'udp',
                originalPort: 443,
                sniffedProtocol: 'quic',
                requestedAt: '2026-07-08T12:00:01.000Z',
            },
        ],
        metrics: {
            queueDepth: 0,
            droppedEventsTotal: 0,
            retryAttemptsTotal: 0,
            lastSuccessfulDeliveryAt: 1_783_516_801_000,
        },
    });

    assert.equal(extendedPayload.schemaVersion, 2);
    assert.equal(extendedPayload.events[0].destination, 'sniffed.example.com');
    assert.equal(extendedPayload.events[0].originalDestination, '203.0.113.20');
    assert.equal(extendedPayload.events[0].sniffedProtocol, 'quic');

    assert.equal(
        ingestTrafficLogsSchema.safeParse({
            schemaVersion: 3,
            events: oldPayload.events,
            metrics: oldPayload.metrics,
        }).success,
        false,
    );
    assert.equal(
        ingestTrafficLogsSchema.safeParse({
            schemaVersion: 2,
            events: [
                {
                    ...oldPayload.events[0],
                    originalDestination: 'a'.repeat(254),
                    sniffedProtocol: 'made-up-sniffer',
                },
            ],
            metrics: oldPayload.metrics,
        }).success,
        false,
    );
    assert.equal(
        ingestTrafficLogsSchema.safeParse({
            schemaVersion: 2,
            events: [
                {
                    ...oldPayload.events[0],
                    originalDestination: '203.0.113.20',
                    originalDestinationType: 'IPV4',
                    sniffedProtocol: 'tls',
                },
            ],
            metrics: oldPayload.metrics,
        }).success,
        false,
    );
});

test('hide rules normalize domains and validate whole-string globs', () => {
    const settings = TrafficAuditSettingsSchema.parse({
        hideRules: [
            { type: 'SUFFIX', pattern: 'Example.COM.' },
            { type: 'GLOB', pattern: '*.internal?.example' },
        ],
    });

    assert.equal(settings.hideRules[0].pattern, 'example.com');
    assert.match('a.internal1.example', new RegExp(globToRegex(settings.hideRules[1].pattern)));
    assert.doesNotMatch('prefix-a.internal1.example-suffix', new RegExp(globToRegex('a.*')));
    assert.equal(
        TrafficAuditSettingsSchema.safeParse({
            hideRules: [{ type: 'GLOB', pattern: '***' }],
        }).success,
        false,
    );
});

test('credential authentication rejects an invalid secret without trusting node identity', async () => {
    const service = new TrafficAuditCredentialService(
        {
            trafficAuditCredentials: {
                findUnique: async () => ({
                    nodeUuid: 'f817ba21-2931-41ec-a9bf-26c9543b6d77',
                    secretHash: '0'.repeat(64),
                }),
            },
        },
        {
            get: async () => null,
            set: async () => {},
        },
    );

    await assert.rejects(
        service.authenticate(`${'a'.repeat(24)}.${'b'.repeat(43)}`),
        /Invalid traffic audit credential/,
    );
});

test('credential rotation immediately revokes the cached old credential', async () => {
    const nodeUuid = randomUUID();
    const oldId = 'a'.repeat(24);
    const oldSecret = 'b'.repeat(43);
    const cache = new Map();
    let stored = {
        credentialId: oldId,
        secretHash: createHash('sha256').update(oldSecret).digest('hex'),
        nodeUuid,
        issuedAt: new Date(),
    };

    const prisma = {
        trafficAuditCredentials: {
            findUnique: async ({ where }) => {
                if (!stored) return null;
                if (
                    where.nodeUuid === stored.nodeUuid ||
                    where.credentialId === stored.credentialId
                ) {
                    return stored;
                }
                return null;
            },
        },
        nodes: {
            findUnique: async ({ where }) => (where.uuid === nodeUuid ? { uuid: nodeUuid } : null),
        },
        $transaction: async (callback) =>
            callback({
                trafficAuditCredentials: {
                    deleteMany: async () => {
                        stored = null;
                    },
                    create: async ({ data }) => {
                        stored = { ...data, issuedAt: new Date() };
                        return { issuedAt: stored.issuedAt };
                    },
                },
            }),
    };
    const service = new TrafficAuditCredentialService(prisma, {
        get: async (key) => cache.get(key) ?? null,
        set: async (key, value) => cache.set(key, value),
        del: async (key) => cache.delete(key),
    });

    assert.equal(await service.authenticate(`${oldId}.${oldSecret}`), nodeUuid);
    const rotated = await service.rotate(nodeUuid);

    await assert.rejects(
        service.authenticate(`${oldId}.${oldSecret}`),
        /Invalid traffic audit credential/,
    );
    assert.equal(await service.authenticate(rotated.credential), nodeUuid);
    assert.equal(rotated.credential.split('.').length, 2);
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
        const nodeUuid = randomUUID();
        const now = Date.now();

        try {
            await clickhouse.onModuleInit();
            await clickhouse.insert([
                {
                    eventId,
                    userId: 1n,
                    userUuid,
                    nodeUuid,
                    destination: 'integration.example.com',
                    destinationType: 'DOMAIN',
                    network: 'tcp',
                    port: 443,
                    requestedAt: new Date(now - 2_000),
                    clientIdentifier: 'integration-user',
                },
                {
                    eventId: randomUUID(),
                    userId: 1n,
                    userUuid,
                    nodeUuid,
                    destination: 'sub.noise.example.com',
                    destinationType: 'DOMAIN',
                    network: 'tcp',
                    port: 443,
                    requestedAt: new Date(now - 1_000),
                    clientIdentifier: 'integration-user',
                },
                {
                    eventId: randomUUID(),
                    userId: 1n,
                    userUuid,
                    nodeUuid,
                    destination: 'keep.other.test',
                    destinationType: 'DOMAIN',
                    network: 'udp',
                    port: 53,
                    requestedAt: new Date(now),
                    clientIdentifier: 'integration-user',
                },
                {
                    eventId: randomUUID(),
                    userId: 1n,
                    userUuid,
                    nodeUuid,
                    destination: 'sniffed.integration.example.com',
                    destinationType: 'DOMAIN',
                    network: 'udp',
                    port: 443,
                    originalDestination: '203.0.113.20',
                    originalDestinationType: 'IPV4',
                    originalNetwork: 'udp',
                    originalPort: 443,
                    sniffedProtocol: 'quic',
                    requestedAt: new Date(now + 1_000),
                    clientIdentifier: 'integration-user',
                },
            ]);

            const page = await clickhouse.getUserLogs({ userUuid, limit: 1 });

            assert.equal(page.items.length, 1);
            assert.equal(page.items[0].destination, 'sniffed.integration.example.com');
            assert.equal(page.items[0].originalDestination, '203.0.113.20');
            assert.equal(page.items[0].originalDestinationType, 'IPV4');
            assert.equal(page.items[0].sniffedProtocol, 'quic');
            assert.ok(page.nextCursor);
            assert.equal(
                getTrafficLogsResponseSchema.safeParse({
                    response: page,
                }).success,
                true,
            );

            const secondPage = await clickhouse.getUserLogs({
                userUuid,
                limit: 1,
                cursor: page.nextCursor,
            });
            assert.equal(secondPage.items[0].destination, 'keep.other.test');
            assert.equal(secondPage.items[0].originalDestination, null);
            assert.equal(secondPage.items[0].originalDestinationType, null);
            assert.equal(secondPage.items[0].sniffedProtocol, null);

            const filtered = await clickhouse.getUserLogs({
                userUuid,
                limit: 10,
                destination: 'other',
                from: new Date(now - 500).toISOString(),
                to: new Date(now + 500).toISOString(),
                destinationType: 'DOMAIN',
                nodeUuid,
                network: 'udp',
                port: 53,
            });
            assert.deepEqual(
                filtered.items.map((item) => item.destination),
                ['keep.other.test'],
            );

            const hiddenBySuffix = await clickhouse.getUserLogs({
                userUuid,
                limit: 10,
                hideRules: [{ type: 'SUFFIX', pattern: 'noise.example.com' }],
            });
            assert.equal(
                hiddenBySuffix.items.some((item) => item.destination === 'sub.noise.example.com'),
                false,
            );

            const hiddenByGlob = await clickhouse.getUserLogs({
                userUuid,
                limit: 10,
                hideRules: [{ type: 'GLOB', pattern: '*.example.com' }],
            });
            assert.deepEqual(
                hiddenByGlob.items.map((item) => item.destination),
                ['keep.other.test'],
            );
            assert.equal(
                hiddenByGlob.items.some((item) => item.id === eventId),
                false,
            );

            const rawExtendedResult = await clickhouse.client.query({
                query: `
                    SELECT
                        destination,
                        original_destination,
                        original_destination_type,
                        original_network,
                        original_port,
                        sniffed_protocol
                    FROM traffic_logs FINAL
                    WHERE user_uuid = {userUuid:UUID}
                    ORDER BY requested_at ASC
                `,
                query_params: { userUuid },
                format: 'JSONEachRow',
            });
            const rawExtendedRows = await rawExtendedResult.json();
            const oldStoredRow = rawExtendedRows.find(
                (row) => row.destination === 'integration.example.com',
            );
            const extendedStoredRow = rawExtendedRows.find(
                (row) => row.destination === 'sniffed.integration.example.com',
            );

            assert.equal(oldStoredRow.original_destination, null);
            assert.equal(oldStoredRow.sniffed_protocol, null);
            assert.equal(extendedStoredRow.original_destination, '203.0.113.20');
            assert.equal(extendedStoredRow.original_destination_type, 'IPV4');
            assert.equal(extendedStoredRow.original_network, 'udp');
            assert.equal(extendedStoredRow.original_port, 443);
            assert.equal(extendedStoredRow.sniffed_protocol, 'quic');

            const definitionResult = await clickhouse.client.query({
                query: `SHOW CREATE TABLE traffic_logs`,
                format: 'JSONEachRow',
            });
            const [definition] = await definitionResult.json();

            assert.match(definition.statement, /TTL requested_at \+ toIntervalDay\(30\)/);
            assert.match(
                definition.statement,
                /`original_destination` Nullable\(String\) DEFAULT NULL/,
            );
            assert.match(definition.statement, /`sniffed_protocol` Nullable\(String\) DEFAULT NULL/);
        } finally {
            await clickhouse.onModuleDestroy();
        }
    },
);
