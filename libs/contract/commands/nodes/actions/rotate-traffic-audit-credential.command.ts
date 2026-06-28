import { z } from 'zod';

import { getEndpointDetails } from '../../../constants';
import { NODES_ROUTES, REST_API } from '../../../api';

export namespace RotateTrafficAuditCredentialCommand {
    export const url = REST_API.NODES.ACTIONS.ROTATE_TRAFFIC_AUDIT_CREDENTIAL;
    export const TSQ_url = url(':uuid');

    export const endpointDetails = getEndpointDetails(
        NODES_ROUTES.ACTIONS.ROTATE_TRAFFIC_AUDIT_CREDENTIAL(':uuid'),
        'post',
        'Rotate traffic audit credential',
    );

    export const RequestSchema = z.object({
        uuid: z.string().uuid(),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            trafficAuditCredential: z.string(),
            issuedAt: z.string().datetime({ offset: true }),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
