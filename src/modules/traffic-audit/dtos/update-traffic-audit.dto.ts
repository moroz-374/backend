import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateTrafficAuditSchema = z.object({
    enabled: z.boolean(),
});

export class UpdateTrafficAuditDto extends createZodDto(updateTrafficAuditSchema) {}