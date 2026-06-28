import { createZodDto } from 'nestjs-zod';

import { RotateTrafficAuditCredentialCommand } from '@contract/commands';

export class RotateTrafficAuditCredentialRequestDto extends createZodDto(
    RotateTrafficAuditCredentialCommand.RequestSchema,
) {}

export class RotateTrafficAuditCredentialResponseDto extends createZodDto(
    RotateTrafficAuditCredentialCommand.ResponseSchema,
) {}
