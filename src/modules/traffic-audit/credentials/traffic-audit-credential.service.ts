import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '@common/database/prisma.service';
import { RawCacheService } from '@common/raw-cache';

interface CachedCredential {
    nodeUuid: string | null;
    secretHash: string;
}

const CACHE_TTL_SECONDS = 300;
const CACHE_PREFIX = 'traffic-audit:credential:';

@Injectable()
export class TrafficAuditCredentialService {
    private readonly logger = new Logger(TrafficAuditCredentialService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly cache: RawCacheService,
    ) {}

    public async issueUnbound(): Promise<string> {
        const credential = createCredential();

        await this.prisma.trafficAuditCredentials.create({
            data: {
                credentialId: credential.credentialId,
                secretHash: credential.secretHash,
            },
        });

        return credential.plaintext;
    }

    public async rotate(nodeUuid: string): Promise<{ credential: string; issuedAt: Date }> {
        const credential = createCredential();
        const previous = await this.prisma.trafficAuditCredentials.findUnique({
            where: { nodeUuid },
            select: { credentialId: true },
        });

        const node = await this.prisma.nodes.findUnique({
            where: { uuid: nodeUuid },
            select: { uuid: true },
        });

        if (!node) {
            throw new NotFoundException('Node not found');
        }

        if (previous) {
            await this.revokeCached(previous.credentialId);
        }

        let issued: { issuedAt: Date };

        try {
            issued = await this.prisma.$transaction(async (tx) => {
                await tx.trafficAuditCredentials.deleteMany({ where: { nodeUuid } });

                return tx.trafficAuditCredentials.create({
                    data: {
                        credentialId: credential.credentialId,
                        secretHash: credential.secretHash,
                        nodeUuid,
                    },
                    select: { issuedAt: true },
                });
            });
        } catch (error) {
            if (previous) {
                await this.invalidate(previous.credentialId);
            }
            throw error;
        }

        if (previous) {
            try {
                await this.invalidate(previous.credentialId);
            } catch (error) {
                this.logger.warn(
                    `Old traffic audit credential remains cache-revoked until TTL: ${getErrorMessage(error)}`,
                );
            }
        }

        return { credential: credential.plaintext, issuedAt: issued.issuedAt };
    }

    public async authenticate(plaintext: string): Promise<string> {
        const { credentialId, secret } = parseCredential(plaintext);

        let stored = await this.cache.get<CachedCredential>(cacheKey(credentialId));

        if (!stored) {
            stored = await this.prisma.trafficAuditCredentials.findUnique({
                where: { credentialId },
                select: { nodeUuid: true, secretHash: true },
            });

            if (stored?.nodeUuid) {
                await this.cache.set(cacheKey(credentialId), stored, CACHE_TTL_SECONDS);
            }
        }

        const receivedHash = hashSecret(secret);

        if (!stored || !stored.nodeUuid || !safeHashEqual(receivedHash, stored.secretHash)) {
            throw new UnauthorizedException('Invalid traffic audit credential');
        }

        return stored.nodeUuid;
    }

    public async validateUnbound(plaintext: string): Promise<string> {
        const { credentialId, secret } = parseCredential(plaintext);
        const stored = await this.prisma.trafficAuditCredentials.findUnique({
            where: { credentialId },
            select: { nodeUuid: true, secretHash: true },
        });

        if (
            !stored ||
            stored.nodeUuid !== null ||
            !safeHashEqual(hashSecret(secret), stored.secretHash)
        ) {
            throw new UnauthorizedException('Invalid traffic audit credential');
        }

        return credentialId;
    }

    public async invalidate(credentialId: string): Promise<void> {
        await this.cache.del(cacheKey(credentialId));
    }

    private async revokeCached(credentialId: string): Promise<void> {
        await this.cache.set(
            cacheKey(credentialId),
            { nodeUuid: null, secretHash: '0'.repeat(64) } satisfies CachedCredential,
            CACHE_TTL_SECONDS,
        );
    }
}

function createCredential(): {
    credentialId: string;
    plaintext: string;
    secretHash: string;
} {
    const credentialId = randomBytes(18).toString('base64url');
    const secret = randomBytes(32).toString('base64url');

    return {
        credentialId,
        plaintext: `${credentialId}.${secret}`,
        secretHash: hashSecret(secret),
    };
}

function hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');

    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cacheKey(credentialId: string): string {
    return `${CACHE_PREFIX}${credentialId}`;
}

function parseCredential(plaintext: string): { credentialId: string; secret: string } {
    const separator = plaintext.indexOf('.');

    if (separator < 1 || separator === plaintext.length - 1) {
        throw new UnauthorizedException('Invalid traffic audit credential');
    }

    const credentialId = plaintext.slice(0, separator);
    const secret = plaintext.slice(separator + 1);

    if (!/^[A-Za-z0-9_-]{20,64}$/.test(credentialId) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
        throw new UnauthorizedException('Invalid traffic audit credential');
    }

    return { credentialId, secret };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
