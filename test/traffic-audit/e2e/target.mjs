import http from 'node:http';
import dgram from 'node:dgram';

http.createServer((_request, response) => response.end('traffic-audit-e2e')).listen(8080, '0.0.0.0');

const udp = dgram.createSocket('udp4');
udp.on('message', (message, remote) => udp.send(message, remote.port, remote.address));
udp.bind(5300, '0.0.0.0');
