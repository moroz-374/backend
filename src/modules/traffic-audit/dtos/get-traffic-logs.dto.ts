import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const getTrafficLogsSchema = z.object({
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
});

export class GetTrafficLogsDto extends createZodDto(getTrafficLogsSchema) {}