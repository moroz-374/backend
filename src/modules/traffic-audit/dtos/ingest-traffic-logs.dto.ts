import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const destinationTypeSchema = z.enum(['DOMAIN', 'IPV4', 'IPV6', 'UNKNOWN']);
const networkSchema = z.enum(['tcp', 'udp']);

const destinationSchema = z
    .string()
    .min(1)
    .max(253)
    .transform((value) => value.trim().toLowerCase().replace(/\.$/, ''));

const trafficEventSchema = z
    .object({
        eventId: z.string().uuid(),
        clientIdentifier: z.string().min(1).max(255),

        destination: destinationSchema,
        destinationType: destinationTypeSchema,

        network: networkSchema,
        port: z.number().int().min(1).max(65535),

        originalDestination: destinationSchema.optional(),
        originalDestinationType: destinationTypeSchema.optional(),
        originalNetwork: networkSchema.optional(),
        originalPort: z.number().int().min(1).max(65535).optional(),
        sniffedProtocol: z.enum(['http', 'tls', 'quic', 'fakedns', 'fakedns+others']).optional(),

        requestedAt: z.string().datetime({ offset: true }),
    })
    .superRefine((event, context) => {
        const extendedFields = [
            event.originalDestination,
            event.originalDestinationType,
            event.originalNetwork,
            event.originalPort,
            event.sniffedProtocol,
        ];
        const hasExtendedFields = extendedFields.some((value) => value !== undefined);
        const hasAllExtendedFields = extendedFields.every((value) => value !== undefined);

        if (hasExtendedFields && !hasAllExtendedFields) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Extended traffic audit fields must be provided together',
            });
        }
    });

export const ingestTrafficLogsSchema = z.object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    events: z.array(trafficEventSchema).min(1).max(5000),
    metrics: z.object({
        queueDepth: z.number().int().min(0),
        droppedEventsTotal: z.number().int().min(0),
        retryAttemptsTotal: z.number().int().min(0),
        lastSuccessfulDeliveryAt: z.number().int().min(0).nullable(),
    }),
});

export class IngestTrafficLogsDto extends createZodDto(ingestTrafficLogsSchema) {}
