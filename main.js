const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');

const PORT = 37642;
let server = null;

// Local diagnostics only: no headers, bodies, Gist IDs, image data or note text.
// Bounded asynchronous writes; any logging failure is isolated from app behavior.
const diagnosticFs = require('fs').promises;
const DIAGNOSTIC_LIMIT = 1024 * 1024;
let diagnosticQueue = Promise.resolve(), diagnosticPending = 0;
function memoDiagnostic(event, fields = {}) {
  try {
    if (diagnosticPending >= 200) return;
    const line = JSON.stringify({at:new Date().toISOString(), event, ...fields}) + '\n';
    if (Buffer.byteLength(line) > 4096) return;
    diagnosticPending++;
    diagnosticQueue = diagnosticQueue.then(async () => {
      const folder = path.join(app.getPath('userData'), 'diagnostics');
      const current = path.join(folder, 'events.jsonl');
      const previous = path.join(folder, 'events.previous.jsonl');
      await diagnosticFs.mkdir(folder, {recursive:true});
      let size = 0;
      try { size = (await diagnosticFs.stat(current)).size; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (size + Buffer.byteLength(line) > DIAGNOSTIC_LIMIT) {
        await diagnosticFs.rm(previous, {force:true});
        await diagnosticFs.rename(current, previous);
      }
      await diagnosticFs.appendFile(current, line, 'utf8');
    }).catch(() => {}).finally(() => { diagnosticPending--; });
  } catch (_) {}
}
function memoSafeDiagnostic(handler) {
  return (...args) => { try { handler(...args); } catch (_) {} };
}
function memoReason(value) {
  return ['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed',
    'integrity-failure','memory-eviction'].includes(value) ? value : 'unknown';
}
const diagnosticSessions = new WeakSet();
function attachMemoDiagnostics(contents) {
  const wc = contents.id;
  contents.on('render-process-gone', memoSafeDiagnostic((_event, detail) => {
    memoDiagnostic('renderer.gone', {wc, reason:memoReason(detail.reason), exitCode:detail.exitCode});
  }));
  contents.on('unresponsive', memoSafeDiagnostic(() => memoDiagnostic('renderer.unresponsive', {wc})));
  contents.on('responsive', memoSafeDiagnostic(() => memoDiagnostic('renderer.responsive', {wc})));
  contents.on('console-message', memoSafeDiagnostic((event) => {
    // Electron 42 exposes message/sourceId on the event object.
    if (typeof event.message !== 'string' || !event.message.startsWith('[memo-diag] ') || event.message.length > 2048) return;
    const source = new URL(event.sourceId);
    if (source.origin !== 'http://127.0.0.1:' + PORT || source.pathname !== '/result_gallery.html') return;
    const record = JSON.parse(event.message.slice(12));
    const allowed = ['gist.upload.start','gist.upload.prepare','gist.upload.prepared',
      'gist.upload.error','gist.upload.success','gist.upload.http-error','gist.upload.retry',
      'gist.upload.previous-read-error','gist.download.start','gist.download.ready',
      'gist.download.error','gist.download.http-error','gist.download.empty',
      'gist.download.cancel','gist.download.apply','gist.download.success',
      'gist.request.start','gist.request.response','gist.request.error',
      'gist.prepare.phase','gist.upload.response-body-start','gist.upload.response-body-end','gist.upload.local-error',
      'gist.verify.start','gist.verify.match','gist.verify.mismatch','gist.verify.unavailable'];
    if (!allowed.includes(record.event)) return;
    const fields = {wc};
    for (const key of ['request','elapsedMs','status','chars','slots','slot','heapUsedBytes','heapTotalBytes','heapLimitBytes']) {
      if (Number.isFinite(record[key]) && record[key] >= 0) fields[key] = record[key];
    }
    if (typeof record.online === 'boolean') fields.online = record.online;
    if (['copy-start','copy-end','json-start','json-end','compress-start','compress-end','body-start','body-end'].includes(record.phase)) fields.phase = record.phase;
    if (record.event === 'gist.prepare.phase') {
      try {
        const metric = app.getAppMetrics().find(item => item.pid === contents.getOSProcessId());
        for (const key of ['workingSetSize','privateBytes']) {
          if (Number.isFinite(metric?.memory?.[key])) fields[key] = metric.memory[key];
        }
      } catch (_) {}
    }
    if (['upload-read','upload-write','download-read','raw-read','verify-read','verify-raw'].includes(record.stage)) fields.stage = record.stage;
    if (['manual','auto'].includes(record.mode)) fields.mode = record.mode;
    if (['fetch-failed','TypeError','RangeError','SyntaxError','AbortError','other'].includes(record.error)) fields.error = record.error;
    memoDiagnostic(record.event, fields);
  }));
  const session = contents.session;
  if (!diagnosticSessions.has(session)) {
    diagnosticSessions.add(session);
    session.webRequest.onErrorOccurred({urls:['https://api.github.com/*','https://gist.githubusercontent.com/*']},
      memoSafeDiagnostic(detail => {
        const host = new URL(detail.url).hostname;
        memoDiagnostic('gist.network-error', {
          wc:detail.webContentsId, request:detail.id,
          endpoint:host === 'api.github.com' ? 'github-api' : 'gist-raw',
          method:['GET','POST','PATCH','OPTIONS'].includes(detail.method) ? detail.method : 'other',
          error:/^net::ERR_[A-Z0-9_]+$/.test(detail.error) ? detail.error : 'network-error'
        });
      }));
  }
}
app.on('web-contents-created', memoSafeDiagnostic((_event, contents) => attachMemoDiagnostics(contents)));
app.on('child-process-gone', memoSafeDiagnostic((_event, detail) => {
  memoDiagnostic('child.gone', {
    process:detail.type === 'GPU' ? 'GPU' : 'other',
    reason:memoReason(detail.reason), exitCode:detail.exitCode
  });
}));
app.on('ready', memoSafeDiagnostic(() => memoDiagnostic('app.ready')));


// Windows 작업표시줄 아이콘 고정
if (process.platform === 'win32') {
  app.setAppUserModelId('com.kyeoul.memohub');
}


// Read only a bounded tail of the two diagnostic files, on explicit request.
async function memoReadRecentDiagnostics() {
  const folder = path.join(app.getPath('userData'), 'diagnostics');
  const rows = [];
  let partial = false;
  for (const name of ['events.previous.jsonl', 'events.jsonl']) {
    let handle;
    try {
      handle = await diagnosticFs.open(path.join(folder, name), 'r');
      const size = (await handle.stat()).size;
      const length = Math.min(size, 64 * 1024), start = size - length;
      const buffer = Buffer.alloc(length);
      const {bytesRead} = await handle.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row.event !== 'string' || !/^(app\.ready|renderer\.(gone|unresponsive|responsive)|child\.gone|gist\.[a-z.-]+)$/.test(row.event)) continue;
          if (typeof row.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.at)) continue;
          const clean = {at:row.at, event:row.event.slice(0,64)};
          for (const key of ['wc','request','elapsedMs','status','chars','slots','slot','exitCode','heapUsedBytes','heapTotalBytes','heapLimitBytes','workingSetSize','privateBytes']) {
            if (Number.isFinite(row[key])) clean[key] = row[key];
          }
          const choices = {
            reason:['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction','unknown'],
            process:['GPU','other'], endpoint:['github-api','gist-raw'], method:['GET','POST','PATCH','OPTIONS','other'],
            stage:['upload-read','upload-write','download-read','raw-read','verify-read','verify-raw'],mode:['manual','auto'],
            phase:['copy-start','copy-end','json-start','json-end','compress-start','compress-end','body-start','body-end']
          };
          for (const [key, values] of Object.entries(choices)) if (values.includes(row[key])) clean[key] = row[key];
          if (typeof row.online === 'boolean') clean.online = row.online;
          if (['fetch-failed','TypeError','RangeError','SyntaxError','AbortError','other','network-error'].includes(row.error)
            || (typeof row.error === 'string' && /^net::ERR_[A-Z0-9_]{1,80}$/.test(row.error))) clean.error = row.error;
          rows.push(clean);
        } catch (_) { partial = true; }
      }
    } catch (e) { if (e.code !== 'ENOENT') partial = true; }
    finally { if (handle) { try { await handle.close(); } catch (_) {} } }
  }
  return {version:1, records:rows.slice(-100), partial};
}
async function memoDiagnosticsRoute(req, res) {
  // Require a same-origin fetch with our header; don't expose file paths or allow CORS.
  const origin = 'http://127.0.0.1:' + PORT;
  if (req.headers.host !== '127.0.0.1:' + PORT || req.headers['x-memo-diagnostics'] !== '1'
    || (req.headers.origin && req.headers.origin !== origin)
    || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    res.sendStatus(403); return;
  }
  res.set('Cache-Control', 'no-store');
  try { res.json(await memoReadRecentDiagnostics()); }
  catch (_) { res.status(503).json({version:1, records:[], unavailable:true}); }
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const web = express();
    web.get('/__memo_diagnostics', memoDiagnosticsRoute);

    // 현재 폴더의 html/js/css/png 등을 정적 파일로 제공
    web.use(express.static(__dirname));

    server = web.listen(PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${PORT}`);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

async function createWindow() {
  const baseUrl = await startLocalServer();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    title: 'Memo Hub',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(`${baseUrl}/index.html`);

  // 필요하면 개발 중에만 켜기
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error(err);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (server) server.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((err) => {
      console.error(err);
    });
  }
});