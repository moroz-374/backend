export class KeygenResponseModel {
    public pubKey: string;
    public trafficAuditCredential: string;

    constructor(payload: string, trafficAuditCredential: string) {
        this.pubKey = payload;
        this.trafficAuditCredential = trafficAuditCredential;
    }
}
