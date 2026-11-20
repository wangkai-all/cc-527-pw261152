import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, txn } from './db.js';
import { ingestPo, ingestPriceRevision, ingestReceipt, ingestInvoice, ingestPayment } from './ingest.js';
import { runMatching } from './matching.js';
import { proposeFix, approveFix, rejectFix } from './fixes.js';
import * as q from './queries.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

const INGESTERS = {
  po: ingestPo,
  price_revision: ingestPriceRevision,
  receipt: ingestReceipt,
  invoice: ingestInvoice,
  payment: ingestPayment,
};

export function createServer(db = openDb(process.env.DB_PATH || ':memory:')) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) + '$'
    );
    routes.push({ method, regex, keys, handler });
  };

  route('GET', '/api/health', () => ({ ok: true }));
  route('GET', '/api/meta', () => q.meta(db));
  route('GET', '/api/summary', () => q.summary(db));

  route('POST', '/api/ingest/:type', async (req, params) => {
    const ingester = INGESTERS[params.type];
    if (!ingester) throw Object.assign(new Error(`未知单据类型: ${params.type}`), { status: 404 });
    const body = await readBody(req);
    return ingester(db, body);
  });

  route('POST', '/api/matching/run', async (req) => {
    const body = await readBody(req);
    return runMatching(db, { supplierId: body.supplier_id ?? null, note: body.note ?? null });
  });
  route('GET', '/api/matching/runs', () => q.listRuns(db));
  route('GET', '/api/matching/runs/:id/trace', (req, params) => ({
    run_id: Number(params.id),
    links: q.runTrace(db, Number(params.id)),
  }));

  route('GET', '/api/anomalies', (req, params, query) =>
    q.listAnomalies(db, {
      status: query.get('status') || undefined,
      type: query.get('type') || undefined,
      supplierId: query.get('supplier_id') ? Number(query.get('supplier_id')) : undefined,
    })
  );
  route('GET', '/api/anomalies/:id', (req, params) => {
    const a = q.getAnomaly(db, Number(params.id));
    if (!a) throw Object.assign(new Error('异常不存在'), { status: 404 });
    return a;
  });
  route('POST', '/api/anomalies/:id/fixes', async (req, params) => {
    const body = await readBody(req);
    return proposeFix(db, Number(params.id), body.action, body.proposed_by);
  });

  route('GET', '/api/fixes', (req, params, query) => q.listFixes(db, { status: query.get('status') || undefined }));
  route('POST', '/api/fixes/:id/approve', async (req, params) => {
    const body = await readBody(req);
    return approveFix(db, Number(params.id), body.approved_by);
  });
  route('POST', '/api/fixes/:id/reject', async (req, params) => {
    const body = await readBody(req);
    return rejectFix(db, Number(params.id), body.decided_by);
  });

  route('GET', '/api/bills/versions', (req, params, query) =>
    q.listVersions(db, {
      supplierId: query.get('supplier_id') ? Number(query.get('supplier_id')) : undefined,
      period: query.get('period') || undefined,
    })
  );
  route('GET', '/api/bills/versions/:id', (req, params) => {
    const v = q.getVersion(db, Number(params.id));
    if (!v) throw Object.assign(new Error('账单版本不存在'), { status: 404 });
    return v;
  });
  route('GET', '/api/payables', (req, params, query) =>
    q.listPayables(db, {
      supplierId: query.get('supplier_id') ? Number(query.get('supplier_id')) : undefined,
      period: query.get('period') || undefined,
    })
  );

  route('POST', '/api/periods/:period/close', (req, params) =>
    txn(db, () => {
      db.prepare("INSERT INTO periods(period, status) VALUES(?, 'closed') ON CONFLICT(period) DO UPDATE SET status = 'closed'").run(params.period);
      return { period: params.period, status: 'closed' };
    })
  );
  route('POST', '/api/periods/:period/open', (req, params) =>
    txn(db, () => {
      db.prepare("INSERT INTO periods(period, status) VALUES(?, 'open') ON CONFLICT(period) DO UPDATE SET status = 'open'").run(params.period);
      return { period: params.period, status: 'open' };
    })
  );

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.regex);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const result = await r.handler(req, params, url.searchParams);
          sendJson(res, 200, result ?? {});
          return;
        }
        sendJson(res, 404, { error: '接口不存在' });
        return;
      }
      // 静态文件
      let path = normalize(url.pathname).replace(/^([/\\])+/, '');
      if (path === '' || path === '.') path = 'index.html';
      const file = join(PUBLIC_DIR, path);
      if (!file.startsWith(PUBLIC_DIR)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const content = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 404, { error: '页面不存在' });
      } else {
        sendJson(res, err.status || 500, { error: err.message, code: err.code });
      }
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, () => {
    console.log(`供应商账单异常分析系统: http://localhost:${port}`);
  });
}
