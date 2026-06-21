import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const trafficEventSchema = z.object({
    eventId: z.string().uuid(),
    clientIdentifier: z.string().min(1).max(255),

    destination: z.string().min(1).max(253),
    destinationType: z.enum(['DOMAIN', 'IPV4', 'IPV6', 'UNKNOWN']),

    network: z.enum(['tcp', 'udp']),
    port: z.number().int().min(1).max(65535),

    requestedAt: z.string().datetime({ offset: true }),
});

export const ingestTrafficLogsSchema = z.object({
    nodeUuid: z.string().uuid(),
    events: z.array(trafficEventSchema).min(1).max(5000),
});

export class IngestTrafficLogsDto extends createZodDto(ingestTrafficLogsSchema) {}