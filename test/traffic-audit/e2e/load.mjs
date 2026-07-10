import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const backendUrl = process.env.BACKEND_URL;
const ingestUrl = process.env.PROXY_URL ?? backendUrl;
const clickhouseUrl = process.env.CLICKHOUSE_URL;
const clickhouseUser = process.env.CLICKHOUSE_USER;
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD;
const eventCount = Number(process.env.LOAD_EVENT_COUNT ?? '5000');
const batchSize = Number(process.env.LOAD_BATCH_SIZE ?? '100');

assert.ok(Number.isInteger(eventCount) && eventCount >= 1 && eventCount <= 5000, 'LOAD_EVENT_COUNT must be 1..5000');
assert.ok(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 5000, 'LOAD_BATCH_SIZE must be 1..5000');

const credential = (await readFile('/run/e2e/credential', 'utf8')).trim();
const requestedAt = new Date().toISOString();

async function clickhouse(query) {
    const url = new URL(clickhouseUrl);
    url.searchParams.set('database', 'remnawave');
    url.searchParams.set('query', query);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
        },
    });
    const text = await response.text();
    assert.ok(response.ok, `ClickHouse ${response.status}: ${text}`);
    return text.trim();
}

const beforeRows = Number(await clickhouse('SELECT count() FROM traffic_logs'));
const beforeBytes = Number(
    await clickhouse("SELECT coalesce(sum(bytes_on_disk), 0) FROM system.parts WHERE active AND database = 'remnawave' AND table = 'traffic_logs'"),
);
const events = Array.from({ length: eventCount }, (_, index) => ({
    eventId: randomUUID(),
    clientIdentifier: 'audit-enabled',
    destination: `load-${index}.benchmark.example.test`,
    destinationType: 'DOMAIN',
    network: index % 2 === 0 ? 'tcp' : 'udp',
    port: index % 2 === 0 ? 443 : 853,
    originalDestination: `203.0.113.${(index % 250) + 1}`,
    originalDestinationType: 'IPV4',
    originalNetwork: index % 2 === 0 ? 'tcp' : 'udp',
    originalPort: index % 2 === 0 ? 443 : 853,
    sniffedProtocol: index % 2 === 0 ? 'tls' : 'quic',
    requestedAt,
}));

const startedAt = performance.now();
for (let offset = 0; offset < events.length; offset += batchSize) {
    const batch = events.slice(offset, offset + batchSize);
    const response = await fetch(`${ingestUrl}/api/monitoring/ingest`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({
            schemaVersion: 2,
            events: batch,
            metrics: {
                queueDepth: 0,
                droppedEventsTotal: 0,
                retryAttemptsTotal: 0,
                lastSuccessfulDeliveryAt: Date.now(),
            },
        }),
    });
    const body = await response.text();
    assert.ok(response.ok, `ingest batch ${offset / batchSize + 1}: ${response.status} ${body}`);
    assert.deepEqual(JSON.parse(body).response, {
        received: batch.length,
        accepted: batch.length,
        inserted: batch.length,
        discarded: 0,
    });
}
const elapsedMs = performance.now() - startedAt;

const afterRows = Number(await clickhouse('SELECT count() FROM traffic_logs'));
const afterBytes = Number(
    await clickhouse("SELECT coalesce(sum(bytes_on_disk), 0) FROM system.parts WHERE active AND database = 'remnawave' AND table = 'traffic_logs'"),
);
assert.equal(afterRows - beforeRows, eventCount, 'all load events must reach ClickHouse');

console.log(
    JSON.stringify({
        eventCount,
        batchSize,
        requestCount: Math.ceil(eventCount / batchSize),
        elapsedMs: Number(elapsedMs.toFixed(2)),
        eventsPerSecond: Number((eventCount / (elapsedMs / 1000)).toFixed(2)),
        clickhouseRowsAdded: afterRows - beforeRows,
        clickhouseBytesAdded: afterBytes - beforeBytes,
        clickhouseBytesPerEvent: Number(((afterBytes - beforeBytes) / eventCount).toFixed(2)),
    }),
);
