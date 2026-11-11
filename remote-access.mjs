import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRemoteGateway } from './remote-gateway.mjs';

export function tunaFailure(output) {
  if (/tunnel limit reached|tunnel already active/i.test(output)) return 'Tuna: лимит занят другим или зависшим туннелем. Открой manage-tuna.cmd в папке игры, останови старый туннель игры и создай ссылку снова.';
  if (/not logged in|unauthorized|invalid.*(?:key|token)|session.*expired/i.test(output)) return 'Открой setup-tuna.cmd в папке игры и войди в Tuna. Затем создай ссылку ещё раз.';
  if (/domain does not exist|domain unavailable/i.test(output)) return 'Tuna: выбранный домен недоступен. Проверь настройки домена в Tuna.';
  return '';
}

export function createRemoteAccess({ appPort, dataDir, spawnTunnel = spawn, gatewayFactory = createRemoteGateway }) {
  let status = { phase: 'off', link: '', error: '' }, generation = 0, child = null, gateway = null, deadline, expiry;
  async function stop() {
    const stoppedGeneration = ++generation; clearTimeout(deadline); clearTimeout(expiry);
    const oldGateway = gateway, oldChild = child; gateway = null; child = null;
    status = { phase: 'off', link: '', error: '' };
    oldGateway?.revoke();
    if (oldChild && oldChild.exitCode == null && oldChild.signalCode == null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        oldChild.once('exit', () => { clearTimeout(timer); resolve(); });
        oldChild.kill();
      });
    }
    await oldGateway?.close();
    return stoppedGeneration;
  }
  function snapshot() { return { ...status }; }
  async function start(provider = 'tuna') {
    if (!['tuna', 'localhost'].includes(provider)) throw new Error('Неизвестный туннель.');
    const run = await stop();
    if (run !== generation) return snapshot();
    status = { phase: 'starting', link: '', error: '' };
    void (async () => {
      try {
        await mkdir(dataDir, { recursive: true });
        const created = await gatewayFactory({ appPort });
        if (run !== generation) { await created.close(); return; }
        gateway = created;
        const ssh = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
        const args = ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none', '-o', 'IdentityAgent=none',
          '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dataDir, 'tunnel-known-hosts')}`,
          '-o', 'GlobalKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
          '-o', 'ConnectTimeout=12', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
          '-R', `80:127.0.0.1:${created.port}`, 'nokey@localhost.run', '--', '--output', 'json'];
        const bundledTuna = fileURLToPath(new URL('./bin/tuna.exe', import.meta.url));
        const tuna = existsSync(bundledTuna) ? bundledTuna : process.platform === 'win32' ? 'tuna.exe' : 'tuna';
        const processChild = spawnTunnel(provider === 'tuna' ? tuna : ssh, provider === 'tuna'
          ? ['http', `127.0.0.1:${created.port}`, '--inspect=false', '--https-redirect', '--no-colors', '--log=stdout', '--log-format=json'] : args,
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child = processChild;
        let buffer = '';
        const fail = async message => {
          if (run !== generation) return;
          const stopped = await stop(); if (stopped === generation) status = { phase: 'error', link: '', error: message };
        };
        const consume = chunk => {
          if (run !== generation) return;
          buffer = (buffer + chunk.toString('utf8')).slice(-16000);
          // Keep bounded diagnostics locally; never publish tunnel logs through the gateway.
          if (provider === 'tuna') void writeFile(path.join(dataDir, 'tuna.log'), buffer.replace(/\b(?:tak_|tt_)[A-Za-z0-9_.-]+/g, '[redacted]')).catch(() => {});
          if (provider === 'tuna' && tunaFailure(buffer)) {
            void fail(tunaFailure(buffer)); return;
          }
          const pattern = provider === 'tuna' ? /https:\/\/[a-z0-9-]+\.(?:(?:ru|nl)\.tuna\.am|a\.2na\.am|a\.tuna\.free)\b/g : /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)\b/g;
          const matches = [...buffer.matchAll(pattern)].filter(match => !['admin.localhost.run', 'www.localhost.run', 'docs.localhost.run'].includes(new URL(match[0]).hostname));
          const publicOrigin = matches.at(-1)?.[0];
          if (publicOrigin) {
            const link = created.setOrigin(publicOrigin);
            clearTimeout(deadline); clearTimeout(expiry);
            status = { phase: 'ready', link, error: '', expiresAt: created.expiresAt() };
            expiry = setTimeout(() => { void fail('Срок ссылки истёк. Создай новую.'); }, Math.max(1, Date.parse(created.expiresAt()) - Date.now())); expiry.unref();
          }
        };
        processChild.stdout.on('data', consume); processChild.stderr.on('data', consume);
        processChild.on('error', () => { void fail(provider === 'tuna' ? 'Не удалось запустить Tuna. Установи Tuna CLI или положи tuna.exe в папку bin.' : 'Не удалось запустить SSH. Проверь компонент Windows «Клиент OpenSSH».'); });
        processChild.on('close', () => { void fail((provider === 'tuna' && tunaFailure(buffer)) || 'Туннель закрылся. Проверь интернет на ПК и создай новую ссылку.'); });
        deadline = setTimeout(() => { void fail('Не удалось связаться с ' + (provider === 'tuna' ? 'Tuna' : 'localhost.run') + '. Проверь интернет на ПК и попробуй снова.'); }, 45000); deadline.unref();
      } catch { if (run === generation) { const stopped = await stop(); if (stopped === generation) status = { phase: 'error', link: '', error: 'Не удалось создать внешний доступ. Попробуй снова.' }; } }
    })();
    return snapshot();
  }
  return { start, stop, snapshot };
}
