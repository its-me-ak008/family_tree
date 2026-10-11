'use strict';

/**
 * Family tree server.
 *
 * Two jobs, deliberately kept separate:
 *   1. serve the static app (index.html / app.js / styles.css)
 *   2. persist the tree JSON to a file on disk
 *
 * Zero dependencies — Node's own http/fs are enough, and a lockfile-free
 * install keeps this runnable with a bare `node server.js`.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'family-tree.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

/* A tree is small (a few hundred KB at the very worst). Anything larger is
   not a family tree, so refuse it rather than buffering it into memory. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 10;

const SEXES = ['male', 'female', 'other'];

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * The client already sanitises before it posts, but a server that trusts the
 * client has no validation at all — anything can POST here. This re-derives
 * the canonical shape from scratch and *rejects* rather than silently
 * coercing, so a malformed payload can never overwrite a good file.
 *
 * @returns {{ok: true, members: Array}|{ok: false, error: string}}
 */
function validateTree(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Body must be a JSON object.' };
  }

  if (!Array.isArray(payload.members)) {
    return { ok: false, error: 'Body must have a "members" array.' };
  }

  const members = [];
  const seenIds = new Set();

  for (let i = 0; i < payload.members.length; i += 1) {
    const raw = payload.members[i];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `members[${i}] must be an object.` };
    }

    const id = String(raw.id == null ? '' : raw.id).trim();

    if (!id) {
      return { ok: false, error: `members[${i}] is missing an "id".` };
    }

    /* Duplicate ids would make every parent/child lookup ambiguous, and the
       renderer resolves relations by id — so this is a hard error, not a
       de-dupe. */
    if (seenIds.has(id)) {
      return { ok: false, error: `Duplicate member id "${id}".` };
    }
    seenIds.add(id);

    members.push({
      id,
      name: String(raw.name == null || raw.name === '' ? 'Unknown' : raw.name),
      sex: SEXES.includes(raw.sex) ? raw.sex : 'other',
      age: normalizeAge(raw.age),
      deceased: Boolean(raw.deceased),
      spouseIds: normalizeIdList(raw.spouseIds, id),
      parentIds: normalizeIdList(raw.parentIds, id),
      childIds: normalizeIdList(raw.childIds, id)
    });
  }

  /* Relations are stored as ids, so a reference to a member that does not
     exist leaves the renderer drawing a connector to nothing. Report it with
     the offending id so the cause is obvious from the response alone. */
  for (const member of members) {
    for (const key of ['spouseIds', 'parentIds', 'childIds']) {
      for (const ref of member[key]) {
        if (!seenIds.has(ref)) {
          return {
            ok: false,
            error: `Member "${member.id}" has ${key} pointing at unknown id "${ref}".`
          };
        }
      }
    }
  }

  return { ok: true, members };
}

function normalizeAge(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 200) return null;
  return Math.floor(num);
}

/** Coerces to a de-duplicated string id list, dropping blanks and self-links. */
function normalizeIdList(value, ownId) {
  if (!Array.isArray(value)) return [];

  const out = [];
  const seen = new Set();

  for (const entry of value) {
    const id = String(entry == null ? '' : entry).trim();
    if (!id || id === ownId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/* Writes are serialised through this chain. Node is single-threaded but
   `await` is not atomic: two overlapping saves could interleave their
   temp-write/rename steps and lose one of them. */
let writeQueue = Promise.resolve();

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  // Keep the chain alive even when a task rejects.
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function readTree() {
  try {
    const text = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(text);
    const result = validateTree(parsed);

    if (!result.ok) {
      // The file exists but is not usable. Surface it instead of pretending
      // the tree is empty, which would invite the client to overwrite it.
      const error = new Error(`Stored file is invalid: ${result.error}`);
      error.code = 'CORRUPT_STORE';
      throw error;
    }

    return { members: result.members, savedAt: parsed.savedAt || null };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No file yet is a normal first-run state, not an error.
      return { members: [], savedAt: null, empty: true };
    }
    if (error instanceof SyntaxError) {
      const wrapped = new Error('Stored file is not valid JSON.');
      wrapped.code = 'CORRUPT_STORE';
      throw wrapped;
    }
    throw error;
  }
}

/**
 * Writes to a temp file in the same directory, then renames over the target.
 * `rename` is atomic within a filesystem, so a crash mid-write leaves the
 * previous good file intact rather than a half-written one.
 */
async function writeTree(members, { backup = true } = {}) {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const payload = {
    savedAt: new Date().toISOString(),
    members
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  /* Autosaves skip the backup: they fire on every edit, and a 10-slot ring
     filled by a single session's keystrokes preserves nothing worth keeping.
     Explicit saves still snapshot, so the ring holds deliberate versions. */
  if (backup) await backupCurrent();

  const tmp = path.join(DATA_DIR, `.family-tree.${process.pid}.${Date.now()}.tmp`);

  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }

  return payload;
}

/**
 * Copies the current file aside before it is replaced. A save is a full
 * overwrite, so without this a bad client payload silently destroys the
 * previous tree with no way back.
 */
async function backupCurrent() {
  let current;

  try {
    current = await fsp.readFile(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return; // Nothing to preserve yet.
    throw error;
  }

  await fsp.mkdir(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(BACKUP_DIR, `family-tree.${stamp}.json`), current, 'utf8');

  await pruneBackups();
}

/** Keeps the newest MAX_BACKUPS files so the folder cannot grow unbounded. */
async function pruneBackups() {
  const entries = (await fsp.readdir(BACKUP_DIR))
    .filter((name) => name.startsWith('family-tree.') && name.endsWith('.json'))
    .sort();

  const excess = entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS));

  await Promise.all(
    excess.map((name) => fsp.rm(path.join(BACKUP_DIR, name), { force: true }))
  );
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        // Stop reading rather than buffering an unbounded upload.
        reject(Object.assign(new Error('Payload too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(ROOT, relative);

  /* Containment check. Without it, `/../../etc/passwd` (or an encoded form)
     would resolve outside the app directory and serve arbitrary files. */
  const resolved = path.resolve(target);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  /* The data folder is reachable through the API with validation; exposing it
     as a static path too would hand out the backups as well. */
  if (resolved === DATA_DIR || resolved.startsWith(DATA_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(resolved);

    if (stat.isDirectory()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': 'no-cache'
    });

    fs.createReadStream(resolved).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/tree' && req.method === 'GET') {
    try {
      const tree = await readTree();
      sendJson(res, 200, {
        members: tree.members,
        savedAt: tree.savedAt,
        empty: Boolean(tree.empty)
      });
    } catch (error) {
      if (error.code === 'CORRUPT_STORE') {
        sendJson(res, 500, { error: error.message });
        return;
      }
      throw error;
    }
    return true;
  }

  if (pathname === '/api/tree' && (req.method === 'PUT' || req.method === 'POST')) {
    const raw = await readBody(req);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: 'Body is not valid JSON.' });
      return true;
    }

    const result = validateTree(parsed);

    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }

    /* `?autosave=1` marks a background write. It only suppresses the backup
       snapshot — validation and the atomic rename are identical either way. */
    const isAutosave = query.get('autosave') === '1';
    const saved = await enqueueWrite(() => writeTree(result.members, { backup: !isAutosave }));

    sendJson(res, 200, {
      status: 'saved',
      autosave: isAutosave,
      savedAt: saved.savedAt,
      count: saved.members.length,
      file: path.relative(ROOT, DATA_FILE)
    });
    return true;
  }

  if (pathname === '/api/tree') {
    res.writeHead(405, { Allow: 'GET, PUT, POST' });
    res.end();
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, pathname, searchParams);
      if (!handled) sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(`${req.method} ${req.url} failed:`, error);

    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Internal error' });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Family tree server running at http://${HOST}:${PORT}`);
  console.log(`Storing data in ${DATA_FILE}`);
});

module.exports = { server, validateTree, normalizeIdList, normalizeAge };
