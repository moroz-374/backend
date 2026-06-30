import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import dgram from 'node:dgram';
import https from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const backendUrl = process.env.BACKEND_URL;
const nodeUrl = process.env.NODE_URL;
const proxyUrl = process.env.PROXY_URL;
const databaseUrl = process.env.DATABASE_URL;
const nodeUuid = process.env.E2E_NODE_UUID;
const nodeContainer = process.env.NODE_CONTAINER;
const adminToken = (await readFile('/run/e2e/admin-token', 'utf8')).trim();

const users = {
    enabled: { uuid: '30000000-0000-4000-8000-000000000001', username: 'audit-enabled' },
    disabled: { uuid: '30000000-0000-4000-8000-000000000002', username: 'audit-disabled' },
    preEnable: { uuid: '30000000-0000-4000-8000-000000000003', username: 'audit-pre-enable' },
};

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
}

function sql(statement) {
    return run('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]);
}

async function api(path, options = {}, expected = null) {
    const response = await fetch(`${backendUrl}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'https',
            ...options.headers,
        },
    });
    const text = await response.text();
    if (expected !== null) {
        assert.equal(response.status, expected, `${path}: ${text}`);
        return text ? JSON.parse(text) : null;
    }
    assert.ok(response.ok, `${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
}

async function setProxy(mode) {
    const response = await fetch(`${proxyUrl}/control?mode=${mode}`);
    assert.ok(response.ok);
}

async function proxyStats() {
    return fetch(`${proxyUrl}/stats`).then((response) => response.json());
}

async function waitFor(check, message, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function nodeToken() {
    const privateKey = sql('SELECT priv_key FROM keygen ORDER BY created_at LIMIT 1');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
        JSON.stringify({ uuid: null, username: null, role: 'API', iat: now, exp: now + 3600 }),
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

async function nodeApi(path, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(path, nodeUrl);
    const tls = sql("SELECT client_cert || E'\\n---E2E---\\n' || client_key || E'\\n---E2E---\\n' || ca_cert FROM keygen ORDER BY created_at LIMIT 1").split('\n---E2E---\n');

    return new Promise((resolve, reject) => {
        const request = https.request(
            url,
            {
                method,
                headers,
                cert: tls[0],
                key: tls[1],
                ca: tls[2],
                rejectUnauthorized: true,
                checkServerIdentity: () => undefined,
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({
                        ok: response.statusCode >= 200 && response.statusCode < 300,
                        status: response.statusCode,
                        text: () => Promise.resolve(Buffer.concat(chunks).toString()),
                    }),
                );
            },
        );
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

const serverConfig = {
    log: { loglevel: 'warning' },
    inbounds: [
        {
            tag: 'vless-in',
            listen: '0.0.0.0',
            port: 10000,
            protocol: 'vless',
            settings: {
                decryption: 'none',
                clients: [
                    { id: '10000000-0000-4000-8000-000000000001', email: users.enabled.username },
                    { id: '10000000-0000-4000-8000-000000000002', email: users.disabled.username },
                    { id: '10000000-0000-4000-8000-000000000003', email: users.preEnable.username },
                ],
            },
        },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
};

async function startXray(forceRestart = false) {
    const response = await nodeApi('/node/xray/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${nodeToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            internals: {
                forceRestart,
                hashes: {
                    emptyConfig: 'traffic-audit-e2e',
                    inbounds: [{ usersCount: 3, hash: 'traffic-audit-e2e', tag: 'vless-in' }],
                },
            },
            xrayConfig: serverConfig,
        }),
    });
    const text = await response.text();
    assert.ok(response.ok, `start Xray: ${response.status} ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.response.isStarted, true, text);
}

async function tcpViaSocks(port) {
    const body = run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--socks5-hostname',
        `xray-client:${port}`,
        'http://traffic-audit-target:8080/',
    ]);
    assert.match(body, /traffic-audit-e2e/);
}

async function udpViaXray() {
    const socket = dgram.createSocket('udp4');
    const payload = Buffer.from(`udp-${Date.now()}`);
    try {
        const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('UDP reply timeout')), 5_000);
            socket.once('message', (message) => {
                clearTimeout(timer);
                resolve(message);
            });
        });
        socket.send(payload, 1053, 'xray-client');
        assert.deepEqual(await reply, payload);
    } finally {
        socket.close();
    }
}

async function logs(user, query = '') {
    const separator = query ? `?${query}` : '';
    return (await api(`/api/users/${user.uuid}/traffic-audit/logs${separator}`)).response;
}

async function setAudit(user, enabled) {
    return api(`/api/users/${user.uuid}/traffic-audit`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
    });
}

function seedUsers() {
    const values = Object.values(users)
        .map(
            (user, index) => `(
                '${user.uuid}', 'e2e-short-uuid-${index + 1}', '${user.username}', 'ACTIVE',
                now() + interval '1 year', 'trojan-${index + 1}-password',
                '10000000-0000-4000-8000-00000000000${index + 1}', 'shadowsocks-${index + 1}-password'
            )`,
        )
        .join(',');
    sql(`
        INSERT INTO users
            (uuid, short_uuid, username, status, expire_at, trojan_password, vless_uuid, ss_password)
        VALUES ${values};
        UPDATE users SET is_audit_enabled = true, audit_enabled_at = now() - interval '1 minute'
        WHERE uuid = '${users.enabled.uuid}';
    `);
}

async function directIngest(credential, body) {
    return fetch(`${backendUrl}/api/monitoring/ingest`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify(body),
    });
}

function emptyMetrics() {
    return { queueDepth: 0, droppedEventsTotal: 0, retryAttemptsTotal: 0, lastSuccessfulDeliveryAt: null };
}

async function clickhouse(query, body) {
    const url = new URL(process.env.CLICKHOUSE_URL);
    url.searchParams.set('database', 'remnawave');
    url.searchParams.set('query', query);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER}:${process.env.CLICKHOUSE_PASSWORD}`).toString('base64')}`,
        },
        body,
    });
    const text = await response.text();
    assert.ok(response.ok, `ClickHouse: ${response.status} ${text}`);
    return text.trim();
}

console.log('Seeding users and starting the real node-managed Xray core...');
seedUsers();
await startXray();
await new Promise((resolve) => setTimeout(resolve, 1_000));

console.log('Checking disabled discard and immediate toggle with real TCP/UDP connections...');
await tcpViaSocks(1082);
await new Promise((resolve) => setTimeout(resolve, 2_000));
assert.equal((await logs(users.disabled)).items.length, 0);

await setAudit(users.enabled, false);
await tcpViaSocks(1081);
await new Promise((resolve) => setTimeout(resolve, 1_500));
const disabledCount = (await logs(users.enabled)).items.length;
await setAudit(users.enabled, true);
await tcpViaSocks(1081);
await udpViaXray();
await waitFor(async () => (await logs(users.enabled)).items.length >= disabledCount + 2, 'TCP/UDP events were not ingested');

console.log('Checking delayed pre-enable discard and sender retry/backoff...');
await setProxy('fail');
const beforeFailure = await proxyStats();
await tcpViaSocks(1083);
await waitFor(async () => (await proxyStats()).failures > beforeFailure.failures, 'sender did not retry through controlled failure');
await setAudit(users.preEnable, true);
await setProxy('pass');
await waitFor(async () => (await proxyStats()).requests > beforeFailure.requests + 1, 'queued batch was not retried');
await new Promise((resolve) => setTimeout(resolve, 1_000));
assert.equal((await logs(users.preEnable)).items.length, 0);

console.log('Checking cursor, filters, hide rules and invalid query bounds...');
const firstPage = await logs(users.enabled, 'limit=1');
assert.equal(firstPage.items.length, 1);
assert.ok(firstPage.nextCursor);
const secondPage = await logs(users.enabled, `limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
assert.equal(secondPage.items.length, 1);
const udpOnly = await logs(users.enabled, `network=udp&port=5300&nodeUuid=${nodeUuid}`);
assert.ok(udpOnly.items.length >= 1);
await api(`/api/users/${users.enabled.uuid}/traffic-audit/logs?cursor=not-a-cursor`, {}, 400);
await api(`/api/users/${users.enabled.uuid}/traffic-audit/logs?port=0`, {}, 400);
await api(`/api/users/${users.enabled.uuid}/traffic-audit/logs?from=2026-06-29T00:00:00.000Z&to=2026-06-28T00:00:00.000Z`, {}, 400);
sql(`UPDATE remnawave_settings SET traffic_audit_settings = '{"hideRules":[{"type":"EXACT","pattern":"traffic-audit-target"}]}'::jsonb`);
assert.equal((await logs(users.enabled)).items.length, 0);
sql(`UPDATE remnawave_settings SET traffic_audit_settings = '{"hideRules":[]}'::jsonb`);

console.log('Checking credential identity, rotation and invalid credentials...');
const oldCredential = (await readFile('/run/e2e/credential', 'utf8')).trim();
const spoofed = await directIngest(oldCredential, { nodeUuid: randomUUID(), events: [], metrics: emptyMetrics() });
assert.equal(spoofed.status, 400);
const invalid = await directIngest(`${'a'.repeat(24)}.${'b'.repeat(43)}`, { events: [], metrics: emptyMetrics() });
assert.equal(invalid.status, 401);
const identityEvent = {
    eventId: randomUUID(),
    clientIdentifier: users.enabled.username,
    destination: 'identity.e2e.test',
    destinationType: 'DOMAIN',
    network: 'tcp',
    port: 443,
    requestedAt: new Date().toISOString(),
};
assert.equal((await directIngest(oldCredential, { events: [identityEvent], metrics: emptyMetrics() })).status, 200);
await waitFor(async () => (await logs(users.enabled, 'destination=identity.e2e.test')).items[0]?.nodeUuid === nodeUuid, 'credential identity was not used');
const rotated = await api(`/api/nodes/${nodeUuid}/actions/rotate-traffic-audit-credential`, { method: 'POST', body: '{}' });
const newCredential = rotated.response.trafficAuditCredential;
const credentialProbe = {
    ...identityEvent,
    eventId: randomUUID(),
    clientIdentifier: users.disabled.username,
};
assert.equal((await directIngest(oldCredential, { events: [credentialProbe], metrics: emptyMetrics() })).status, 401);
assert.equal((await directIngest(newCredential, { events: [credentialProbe], metrics: emptyMetrics() })).status, 200);
await writeFile('/run/e2e/credential', newCredential, { mode: 0o600 });

console.log('Checking restart policy: unsent memory queue is lost and old access log is not replayed...');
const beforeRestart = (await logs(users.enabled)).items.length;
await setProxy('fail');
const restartFailures = (await proxyStats()).failures;
await tcpViaSocks(1081);
await waitFor(async () => (await proxyStats()).failures > restartFailures, 'restart fixture was not queued');
run('docker', ['restart', nodeContainer]);
await setProxy('pass');
await waitFor(async () => {
    try {
        await startXray();
        return true;
    } catch {
        return false;
    }
}, 'node did not restart', 30_000);
await tcpViaSocks(1081);
await waitFor(async () => (await logs(users.enabled)).items.length === beforeRestart + 1, 'post-restart event missing');
await new Promise((resolve) => setTimeout(resolve, 2_000));
assert.equal((await logs(users.enabled)).items.length, beforeRestart + 1);

console.log('Checking log rotation and queue overflow metrics...');
run('docker', ['exec', nodeContainer, 'sh', '-c', 'mv /var/log/xray/access.log /var/log/xray/access.log.1 && : > /var/log/xray/access.log']);
await startXray(true);
const beforeRotation = (await logs(users.enabled)).items.length;
await tcpViaSocks(1081);
await waitFor(async () => (await logs(users.enabled)).items.length > beforeRotation, 'rotated log event missing');

await setProxy('fail');
for (let index = 0; index < 8; index += 1) await tcpViaSocks(1081);
await new Promise((resolve) => setTimeout(resolve, 2_000));
await setProxy('pass');
await tcpViaSocks(1081);
await waitFor(async () => {
    const metrics = await fetch('http://backend:3001/metrics', {
        headers: { Authorization: `Basic ${Buffer.from('e2e:e2e').toString('base64')}` },
    }).then((response) => response.text());
    return /remnawave_traffic_audit_sender_dropped_events_total\{[^}]*\} [1-9]/.test(metrics) &&
        /remnawave_traffic_audit_sender_retry_attempts_total\{[^}]*\} [1-9]/.test(metrics);
}, 'overflow/retry metrics were not exported');

console.log('Checking ClickHouse TTL with an expired row...');
const expiredId = randomUUID();
await clickhouse(
    "INSERT INTO traffic_logs SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow",
    JSON.stringify({
        event_id: expiredId,
        user_id: '1',
        user_uuid: users.enabled.uuid,
        node_uuid: nodeUuid,
        destination: 'expired.e2e.test',
        destination_type: 'DOMAIN',
        network: 'tcp',
        port: 443,
        requested_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        client_identifier: users.enabled.username,
    }),
);
await clickhouse('OPTIMIZE TABLE traffic_logs FINAL');
const expiredCount = await clickhouse(`SELECT count() FROM traffic_logs WHERE event_id = '${expiredId}'`);
assert.equal(expiredCount, '0');

console.log('Traffic audit end-to-end suite passed.');
