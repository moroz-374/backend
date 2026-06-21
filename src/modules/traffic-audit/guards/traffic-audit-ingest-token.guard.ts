import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class TrafficAuditIngestTokenGuard implements CanActivate {
    constructor(private readonly configService: ConfigService) {}

    public canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<RequestLike>();

        const expectedToken = this.configService.get<string>('TRAFFIC_AUDIT_INGEST_TOKEN');

        if (!expectedToken) {
            throw new UnauthorizedException('Traffic audit ingest token is not configured');
        }

        const authorization = request.headers.authorization;

        if (!authorization?.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing bearer token');
        }

        const receivedToken = authorization.slice('Bearer '.length).trim();

        if (!safeCompare(receivedToken, expectedToken)) {
            throw new UnauthorizedException('Invalid bearer token');
        }

        return true;
    }
}

interface RequestLike {
    headers: {
        authorization?: string;
    };
}

function safeCompare(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a);
    const bBuffer = Buffer.from(b);

    if (aBuffer.length !== bBuffer.length) {
        return false;
    }

    return timingSafeEqual(aBuffer, bBuffer);
}