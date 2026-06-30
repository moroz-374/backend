import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const backendUrl = process.env.BACKEND_URL;
const jwtSecret = process.env.JWT_AUTH_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const nodeUuid = process.env.E2E_NODE_UUID;
const apiTokenUuid = '10000000-0000-4000-8000-000000000001';

function base64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function adminToken() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
        uuid: apiTokenUuid,
        username: null,
        role: 'API',
        iat: now,
        exp: now + 3600,
    })}`;
    const signature = createHmac('sha256', jwtSecret).update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
}

const seedApiToken = spawnSync(
    'psql',
    [
        databaseUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO api_tokens (uuid, token, token_name)
         VALUES ('${apiTokenUuid}', 'traffic-audit-e2e-api-token', 'traffic-audit-e2e')
         ON CONFLICT (uuid) DO NOTHING;`,
    ],
    { encoding: 'utf8' },
);
if (seedApiToken.status !== 0) throw new Error(seedApiToken.stderr || seedApiToken.stdout);

async function request(path, options = {}) {
    const response = await fetch(`${backendUrl}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${adminToken()}`,
            'Content-Type': 'application/json',
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'https',
            ...options.headers,
        },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    return body ? JSON.parse(body) : null;
}

for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
        const generated = await request('/api/keygen');
        const { pubKey, trafficAuditCredential } = generated.response;
        const credentialId = trafficAuditCredential.split('.')[0];

        const sql = `
            INSERT INTO nodes (uuid, name, address, port, country_code, is_disabled)
            VALUES ('${nodeUuid}', 'traffic-audit-e2e', 'traffic-audit-node', 2222, 'XX', true);
            UPDATE traffic_audit_credentials
            SET node_uuid = '${nodeUuid}'
            WHERE credential_id = '${credentialId}' AND node_uuid IS NULL;
        `;
        const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
            encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(result.stderr || result.stdout);

        await mkdir('/run/e2e', { recursive: true });
        await writeFile('/run/e2e/secret-key', pubKey, { mode: 0o600 });
        await writeFile('/run/e2e/credential', trafficAuditCredential, { mode: 0o600 });
        await writeFile('/run/e2e/admin-token', adminToken(), { mode: 0o600 });
        console.log('Traffic audit e2e node provisioned.');
        process.exit(0);
    } catch (error) {
        if (attempt === 119) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
}
