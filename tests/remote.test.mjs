import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRemoteGateway } from '../remote-gateway.mjs';
import { createRemoteAccess, tunaFailure } from '../remote-access.mjs';

function request(port, route, { host = 'unit.lhr.life', origin, body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('внешний вход: ключ, защищённая cookie, запрет обхода, приватные настройки не выдаются', async () => {
  let forwarded = [];
  const gateway = await createRemoteGateway({ appPort: 12345, fetchLocal: async (url, options) => {
    forwarded.push({ url, options });
    return new Response(JSON.stringify({ settings: { model: 'vision', endpoint: 'PRIVATE', memes: 'PRIVATE', yandexFolder: 'PRIVATE' }, history: [{ id: 'PRIVATE', caption: 'PRIVATE' }], memories: ['PRIVATE'], photoHistory: ['PRIVATE'], hasToken: true }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const origin = 'https://unit.lhr.life';
  const link = gateway.setOrigin(origin), key = new URLSearchParams(new URL(link).hash.slice(1)).get('access');
  assert.equal(key.length, 43);
  try {
    const landing = await request(gateway.port, '/'); assert.equal(landing.status, 200); assert.ok(!landing.text.includes(key));
    assert.equal((await request(gateway.port, '/api/state')).status, 401);
    assert.equal((await request(gateway.port, '/app.js')).status, 401);
    assert.equal((await request(gateway.port, '/__access', { origin, body: { key: 'wrong' } })).status, 401);
    assert.equal((await request(gateway.port, '/__access', { body: { key } })).status, 403);
    assert.equal((await request(gateway.port, '/__access', { origin: 'https://evil.test', body: { key } })).status, 403);
    assert.equal((await request(gateway.port, '/__access', { origin, body: { key }, headers: { 'X-Forwarded-Proto': 'http' } })).status, 400);
    const login = await request(gateway.port, '/__access', { origin, body: { key } }); assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(';')[0];
    const state = await request(gateway.port, '/api/state', { cookie }); assert.equal(state.status, 200); assert.ok(!state.text.includes('PRIVATE')); assert.equal(JSON.parse(state.text).remote, true); assert.deepEqual(JSON.parse(state.text).history, []);
    assert.equal((await request(gateway.port, '/api/feedback', {cookie, origin, body:{id:'PRIVATE',comment:'test'}})).status,403);
    assert.equal((await request(gateway.port, '/api/rejudge', {cookie, origin, body:{roundId:'PRIVATE',comment:'test'}})).status,403);
    for (const route of ['/api/share/status', '/api/models', '/data/state.json', '/api/state?test=1']) assert.equal((await request(gateway.port, route, { cookie })).status, 403);
    for (const route of ['/api/settings', '/api/share/start', '/api/share/stop', '/api/shutdown']) assert.equal((await request(gateway.port, route, { origin, cookie, body: {} })).status, 403);
    assert.equal((await request(gateway.port, '/api/round', { cookie, body: {}, origin: 'https://evil.test' })).status, 403);
    assert.equal((await request(gateway.port, '/api/round', { cookie, body: {}, origin })).status, 200);
    assert.equal((await request(gateway.port, '/api/state', { cookie, host: '127.0.0.1:' + gateway.port })).status, 403);
    assert.ok(forwarded.every(x => !x.options.headers.Cookie && !x.options.headers.Authorization));
    gateway.revoke();
    assert.equal((await request(gateway.port, '/api/state', { cookie })).status, 410);
    assert.equal((await request(gateway.port, '/__access', { origin, body: { key } })).status, 410);
  } finally { await gateway.close(); }
});
test('новый адрес меняет ключ и сбрасывает cookie; есть срок действия и ограничение попыток', async () => {
  let clock = Date.now();
  const gateway = await createRemoteGateway({ appPort: 12345, now: () => clock });
  try {
    const one = gateway.setOrigin('https://unit.lhr.life');
    const two = gateway.setOrigin('https://other.lhr.life');
    assert.notEqual(new URL(one).hash, new URL(two).hash);
    assert.throws(() => gateway.setOrigin('https://evil.test'));
    for (let i = 0; i < 30; i++) assert.equal((await request(gateway.port, '/__access', { host: 'other.lhr.life', origin: 'https://other.lhr.life', body: { key: 'wrong' } })).status, 401);
    assert.equal((await request(gateway.port, '/__access', { host: 'other.lhr.life', origin: 'https://other.lhr.life', body: { key: 'wrong' } })).status, 429);
    clock += 12 * 60 * 60 * 1000 + 1;
    assert.equal((await request(gateway.port, '/', { host: 'other.lhr.life' })).status, 410);
  } finally { await gateway.close(); }
});
test('новый запуск отзывает предыдущую ссылку; SSH не использует личные ключи', async () => {
  await mkdir('work', { recursive: true }); const dataDir = await mkdtemp(path.resolve('work/remote-test-'));
  const children = [], ports = [], argsUsed = [];
  const manager = createRemoteAccess({ appPort: 12345, dataDir,
    gatewayFactory: async options => { const gateway = await createRemoteGateway(options); ports.push(gateway.port); return gateway; },
    spawnTunnel: (command, args, options) => {
      argsUsed.push(args); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      children.push(child); setTimeout(() => child.stdout.write('Manage tunnels: https://admin.localhost.run\n{"address":"https://unit.lhr.life"}\n'), 5); return child;
    }
  });
  async function ready() { for (let i = 0; i < 100; i++) { if (manager.snapshot().phase === 'ready') return manager.snapshot(); await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('No ready state'); }
  try {
    await manager.start('localhost'); const first = await ready();
    await manager.start('localhost'); const second = await ready();
    assert.notEqual(first.link, second.link); assert.equal(children[0].killed, true);
    assert.ok(argsUsed[0].includes('IdentityFile=none')); assert.ok(argsUsed[0].includes('IdentityAgent=none')); assert.ok(argsUsed[0].includes('StrictHostKeyChecking=accept-new'));
    await manager.stop(); assert.equal(manager.snapshot().phase, 'off'); assert.equal(children[1].killed, true);
  } finally { await manager.stop(); await rm(dataDir, { recursive: true, force: true }); }
});


test('Tuna address parsing and authentication errors', async () => {
  await mkdir('work', { recursive: true }); const dataDir = await mkdtemp(path.resolve('work/tuna-adapter-'));
  let child, argsUsed;
  const manager = createRemoteAccess({ appPort: 12345, dataDir, spawnTunnel: (command,args) => {
    assert.ok(command.endsWith('tuna.exe')); argsUsed=args;
    child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>child.emit('exit',0); return child;
  }});
  try {
    await manager.start(); while(!child) await new Promise(r=>setTimeout(r,5));
    child.stdout.write('{"msg":"Forwarding https://example.a.2na.am -> 127.0.0.1:12345"}');
    assert.equal(manager.snapshot().phase,'ready'); assert.ok(manager.snapshot().link.startsWith('https://example.a.2na.am/#access='));
    assert.ok(argsUsed.includes('--inspect=false')); await manager.stop();
    child=null; await manager.start(); while(!child) await new Promise(r=>setTimeout(r,5));
    child.stderr.write('Not logged in, run `tuna login`');
    for(let n=0;n<100 && manager.snapshot().phase!=='error';n++)await new Promise(r=>setTimeout(r,5));
    assert.match(manager.snapshot().error,/setup-tuna/);
  } finally { await manager.stop(); await new Promise(r=>setTimeout(r,20)); await rm(dataDir,{recursive:true,force:true}); }
});


test('Tuna current domains and specific quota errors', async () => {
  const gateway = await createRemoteGateway({appPort:1});
  try {
    for (const host of ['example.a.2na.am','example.a.tuna.free','example.ru.tuna.am','example.nl.tuna.am']) assert.ok(gateway.setOrigin('https://'+host).startsWith('https://'+host+'/#access='));
    for (const host of ['example.a.2na.am.evil.test','a.2na.am','example.evil.tuna.am']) assert.throws(()=>gateway.setOrigin('https://'+host));
  } finally { await gateway.close(); }
  assert.match(tunaFailure('Failed to get connection settings: Tunnel limit reached'), /manage-tuna/);
  assert.match(tunaFailure('Tunnel already active'), /manage-tuna/);
  assert.equal(tunaFailure('Welcome to Tuna'), '');
});
