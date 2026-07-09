import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const normalizeDestination = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');
const destinationTypeSchema = z.enum(['DOMAIN', 'IPV4', 'IPV6', 'UNKNOWN']);
const networkSchema = z.enum(['tcp', 'udp']);
const sniffedProtocolSchema = z.enum(['http', 'tls', 'quic', 'fakedns', 'fakedns+others']);

export const getTrafficLogsSchema = z
    .object({
        cursor: z.string().min(1).max(512).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        destination: z.string().trim().min(1).max(253).transform(normalizeDestination).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        destinationType: destinationTypeSchema.optional(),
        nodeUuid: z.string().uuid().optional(),
        network: networkSchema.optional(),
        port: z.coerce.number().int().min(1).max(65535).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: '`to` must not be earlier than `from`',
            });
        }
    });

export class GetTrafficLogsDto extends createZodDto(getTrafficLogsSchema) {}

export const trafficLogItemSchema = z.object({
    id: z.string().uuid(),
    destination: z.string(),
    destinationType: destinationTypeSchema,
    network: networkSchema,
    nodeUuid: z.string().uuid(),
    port: z.number().int().min(1).max(65535),
    originalDestination: z.string().nullable(),
    originalDestinationType: destinationTypeSchema.nullable(),
    sniffedProtocol: sniffedProtocolSchema.nullable(),
    requestedAt: z.string().datetime({ offset: true }),
});

export const getTrafficLogsResponseSchema = z.object({
    response: z.object({
        items: z.array(trafficLogItemSchema),
        nextCursor: z.string().nullable(),
    }),
});

export class GetTrafficLogsResponseDto extends createZodDto(getTrafficLogsResponseSchema) {}
