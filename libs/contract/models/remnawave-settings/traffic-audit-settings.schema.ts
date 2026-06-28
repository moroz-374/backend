import { z } from 'zod';

const normalizePattern = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');

export const TrafficAuditHideRuleSchema = z
    .object({
        type: z.enum(['EXACT', 'SUFFIX', 'GLOB']),
        pattern: z.string().trim().min(1).max(253),
    })
    .superRefine((rule, ctx) => {
        const pattern = normalizePattern(rule.pattern);
        const allowed = rule.type === 'GLOB' ? /^[a-z0-9._:*?-]+$/ : /^[a-z0-9._:-]+$/;

        if (!pattern || !allowed.test(pattern)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['pattern'],
                message: 'Pattern contains unsupported characters',
            });
        }

        if (rule.type === 'SUFFIX' && (!pattern.includes('.') || pattern.includes(':'))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['pattern'],
                message: 'SUFFIX must be a domain name',
            });
        }

        if (rule.type === 'GLOB' && !/[a-z0-9]/.test(pattern)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['pattern'],
                message: 'GLOB must contain at least one literal character',
            });
        }
    })
    .transform((rule) => ({ ...rule, pattern: normalizePattern(rule.pattern) }));

export const TrafficAuditSettingsSchema = z.object({
    hideRules: z.array(TrafficAuditHideRuleSchema).max(200),
});

export type TTrafficAuditSettings = z.infer<typeof TrafficAuditSettingsSchema>;
