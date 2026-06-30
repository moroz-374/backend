import http from 'node:http';

let mode = 'pass';
let requests = 0;
let failures = 0;
const backend = process.env.BACKEND_URL;

http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://proxy');
    if (url.pathname === '/control') {
        mode = url.searchParams.get('mode') === 'fail' ? 'fail' : 'pass';
        response.end(JSON.stringify({ mode }));
        return;
    }
    if (url.pathname === '/stats') {
        response.end(JSON.stringify({ mode, requests, failures }));
        return;
    }
    if (url.pathname === '/health') {
        response.end('ok');
        return;
    }

    requests += 1;
    if (mode === 'fail') {
        failures += 1;
        response.writeHead(503).end('controlled failure');
        return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(`${backend}${request.url}`, {
        method: request.method,
        headers: {
            ...request.headers,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(8080, '0.0.0.0');
