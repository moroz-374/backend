import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { TrafficAuditCredentialService } from '../credentials';

@Injectable()
export class TrafficAuditIngestTokenGuard implements CanActivate {
    constructor(private readonly credentials: TrafficAuditCredentialService) {}

    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestLike>();

        const authorization = request.headers.authorization;

        if (!authorization?.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing bearer token');
        }

        const credential = authorization.slice('Bearer '.length).trim();
        request.trafficAuditNodeUuid = await this.credentials.authenticate(credential);

        return true;
    }
}

interface RequestLike {
    headers: {
        authorization?: string;
    };
    trafficAuditNodeUuid?: string;
}
