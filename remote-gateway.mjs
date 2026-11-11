import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_BODY = 6 * 1024 * 1024;
const COOKIE = "__Host-podpis";
const HOURS_12 = 12 * 60 * 60 * 1000;
const randomSecret = () => randomBytes(32).toString("base64url");
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Слишком большой запрос.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const ENTRY_HTML = `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подпись — вход</title><link rel="stylesheet" href="/__entry.css"><script src="/__entry.js" defer></script></head><body><main><h1>Подпись<span>.</span></h1><p id="message">Открываем игру…</p><p class="hint">Для входа нужна полная ссылка, созданная на твоём ПК.</p><button id="retry" hidden>Попробовать снова</button></main></body></html>`;
const ENTRY_CSS = `body{margin:0;background:#f7f7f2;color:#202b24;font:16px Segoe UI,Arial,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:440px;padding:30px}h1{font-size:45px;letter-spacing:-2px}h1 span{color:#7e9848}.hint{font-size:13px;color:#7b827a;line-height:1.6}button{padding:12px 20px;background:#dcfa86;border:0;border-radius:8px;cursor:pointer}`;
const ENTRY_JS = `let key = new URLSearchParams(location.hash.slice(1)).get('access');
const message = document.getElementById('message');
const retry = document.getElementById('retry');
async function enter(){
  retry.hidden=true;
  if(!key){message.textContent='Ссылка неполная или уже недействительна. Скопируй новую ссылку на ПК.';return;}
  try {
    const r=await fetch('/__access',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    if(!r.ok){message.textContent=r.status===429?'Слишком много попыток. Подожди минуту.':'Эта ссылка больше не действует. Создай новую на ПК.';retry.hidden=r.status!==429;return;}
    const check=await fetch('/api/state',{credentials:'same-origin'});
    if(check.status===401){message.textContent='Разреши cookie для этого сайта и нажми «Попробовать снова».';retry.hidden=false;return;}
    if(!check.ok) throw new Error();
    key=null;location.reload();
  }catch{message.textContent='Нет связи с ПК. Проверь, что игра запущена.';retry.hidden=false;}
}
retry.addEventListener('click',enter);enter();`;

export async function createRemoteGateway({
  appPort,
  now = Date.now,
  fetchLocal = fetch,
} = {}) {
  let secret = randomSecret(),
    origin = "",
    active = true,
    born = now();
  const sessions = new Map();
  let loginWindow = now(),
    loginAttempts = 0;
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    const send = (
      code,
      body,
      type = "application/json; charset=utf-8",
      extra = {},
    ) => {
      res.writeHead(code, { ...headers, "Content-Type": type, ...extra });
      res.end(
        typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
      );
    };
    try {
      if (!active || !origin || now() - born > HOURS_12)
        return send(410, {
          error: "Ссылка больше не действует. Создай новую на ПК.",
        });
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: "Неверный адрес." });
      const url = new URL(req.url, origin);
      // HTTP entrypoints must never receive the access key; the generated link is HTTPS.
      if (
        req.headers["x-forwarded-proto"] &&
        req.headers["x-forwarded-proto"] !== "https"
      )
        return send(400, { error: "Открой полную HTTPS-ссылку." });
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: "Запрос с другого сайта запрещён." });
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          !req.headers["content-type"]?.startsWith("application/json"))
      )
        return send(403, { error: "Запрос запрещён." });
      const token = (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(COOKIE + "="))
        ?.slice(COOKIE.length + 1);
      const signedIn = Boolean(
        token && sessions.has(token) && sessions.get(token).expires > now(),
      );
      if (url.pathname === "/__access" && req.method === "POST") {
        if (now() - loginWindow >= 60000) {
          loginWindow = now();
          loginAttempts = 0;
        }
        if (++loginAttempts > 30)
          return send(429, { error: "Слишком много попыток." }, undefined, {
            "Retry-After": "60",
          });
        let body;
        try {
          body = JSON.parse((await readBody(req, 2048)).toString("utf8"));
        } catch {
          return send(400, { error: "Некорректная ссылка." });
        }
        if (!equal(body?.key, secret))
          return send(401, { error: "Ссылка недействительна." });
        const cookie = randomSecret();
        sessions.set(cookie, {
          expires: born + HOURS_12,
          window: now(),
          calls: 0,
          rounds: new Set(),
          results: new Set(),
        });
        while (sessions.size > 32)
          sessions.delete(sessions.keys().next().value);
        return send(200, { ok: true }, undefined, {
          "Set-Cookie": `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((born + HOURS_12 - now()) / 1000))}`,
        });
      }
      if (req.method === "GET" && url.pathname === "/__entry.js")
        return send(200, ENTRY_JS, "text/javascript; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/__entry.css")
        return send(200, ENTRY_CSS, "text/css; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/" && !signedIn)
        return send(200, ENTRY_HTML, "text/html; charset=utf-8");
      const groupPublic =
        (req.method === "GET" &&
          ["/group", "/group.js", "/group.css"].includes(url.pathname)) ||
        (req.method === "POST" &&
          /^\/api\/rooms\/(create|info|join|leave|state|start|answer|again|retry|feedback|gallery)$/.test(
            url.pathname,
          ));
      if (groupPublic) {
        if (url.search) return send(403, { error: "Недопустимый адрес." });
        const body =
          req.method === "POST" ? await readBody(req, 4096) : undefined;
        const response = await fetchLocal(
          `http://127.0.0.1:${appPort}${url.pathname}`,
          {
            method: req.method,
            headers: {
              "X-Podpis-Remote": "1",
              "X-Podpis-Session": signedIn ? token : "guest",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body } : {}),
            signal: AbortSignal.timeout(10000),
          },
        );
        return send(
          response.status,
          Buffer.from(await response.arrayBuffer()),
          response.headers.get("content-type") || "application/json",
        );
      }
      if (!signedIn)
        return send(401, { error: "Открой полную ссылку, созданную на ПК." });
      const entryNavigation =
        req.method === "GET" &&
        url.pathname === "/" &&
        req.headers["sec-fetch-mode"] === "navigate";
      if (req.headers["sec-fetch-site"] === "cross-site" && !entryNavigation)
        return send(403, { error: "Запрос с другого сайта запрещён." });
      const getRoutes = [
        "/",
        "/app.js",
        "/style.css",
        "/favicon.svg",
        "/api/state",
      ];
      const postRoutes = [
        "/api/round",
        "/api/upload",
        "/api/judge",
        "/api/rejudge",
        "/api/feedback",
      ];
      const allowed =
        req.method === "GET"
          ? getRoutes.includes(url.pathname) ||
            /^\/api\/image\/[a-f0-9-]{36}$/.test(url.pathname)
          : req.method === "POST" && postRoutes.includes(url.pathname);
      if (!allowed || url.search)
        return send(403, {
          error: "Управление подключением и моделью доступно только на ПК.",
        });
      const session = sessions.get(token);
      if (now() - session.window >= 60000) {
        session.window = now();
        session.calls = 0;
      }
      if (++session.calls > 120)
        return send(429, { error: "Слишком много запросов. Подожди минуту." });
      const body =
        req.method === "POST" ? await readBody(req, MAX_BODY) : undefined;
      if (
        url.pathname.startsWith("/api/image/") &&
        !session.rounds.has(url.pathname.split("/").pop())
      )
        return send(403, { error: "Этот кадр недоступен." });
      if (
        body &&
        ["/api/judge", "/api/rejudge", "/api/feedback"].includes(url.pathname)
      ) {
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return send(400, { error: "Некорректный запрос." });
        }
        if (
          !input ||
          (url.pathname === "/api/feedback"
            ? !session.results.has(input.id)
            : !session.rounds.has(input.roundId))
        )
          return send(403, { error: "Этот раунд недоступен." });
      }
      const response = await fetchLocal(
        `http://127.0.0.1:${appPort}${url.pathname}`,
        {
          method: req.method,
          redirect: "error",
          signal: AbortSignal.timeout(190000),
          headers: {
            "X-Podpis-Remote": "1",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
        },
      );
      if (url.pathname === "/api/state" && response.ok) {
        const state = await response.json();
        return send(200, {
          remote: true,
          settings: {
            model: state.settings.model,
            strictness: state.settings.strictness,
            photoProvider: state.settings.photoProvider,
          },
          history: [],
        });
      }
      if (
        response.ok &&
        ["/api/round", "/api/upload", "/api/judge", "/api/rejudge"].includes(
          url.pathname,
        )
      ) {
        const result = await response.json();
        const ids = ["/api/round", "/api/upload"].includes(url.pathname)
          ? session.rounds
          : session.results;
        if (typeof result.id === "string") ids.add(result.id);
        while (ids.size > 100) ids.delete(ids.values().next().value);
        return send(response.status, result);
      }
      return send(
        response.status,
        Buffer.from(await response.arrayBuffer()),
        response.headers.get("content-type") || "application/octet-stream",
      );
    } catch {
      if (!res.headersSent)
        send(502, { error: "Нет связи с игрой на ПК. Попробуй ещё раз." });
      else res.end();
    }
  });
  server.requestTimeout = 200000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    setOrigin(value) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !/^[a-z0-9-]+\.(?:lhr\.life|localhost\.run|(?:ru|nl)\.tuna\.am|a\.2na\.am|a\.tuna\.free)$/.test(
          url.hostname,
        )
      )
        throw new Error("Туннель вернул неизвестный адрес.");
      if (origin !== url.origin) {
        origin = url.origin;
        secret = randomSecret();
        born = now();
        sessions.clear();
      }
      return origin + "/#access=" + secret;
    },
    link: () => (origin ? origin + "/#access=" + secret : ""),
    expiresAt: () => new Date(born + HOURS_12).toISOString(),
    revoke() {
      active = false;
      secret = randomSecret();
      sessions.clear();
    },
    async close() {
      this.revoke();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
