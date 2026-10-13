'use strict';

/**
 * Regression tests for the request-body size limit.
 *
 * The bug these pin down: `readBody` rejected an oversize upload and called
 * `req.destroy()` on the same tick. `req` and `res` share a socket, so the
 * `413` the handler then wrote went into a dead socket and the client saw
 * `ECONNRESET` — no status code at all. The client reported "Could not reach
 * the server" for a server that was running and deliberately refusing.
 *
 * Run with: npm test
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { test, before, after } = require('node:test');

/* Point the server at a throwaway store before requiring it — these tests
   write, and must never be able to reach the real data directory. */
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-test-'));
process.env.FAMILY_TREE_DATA_DIR = TMP_DATA_DIR;

const { server, MAX_BODY_BYTES, DATA_FILE, BACKUP_DIR } = require('../server.js');

let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(TMP_DATA_DIR, { recursive: true, force: true });
});

/**
 * Minimal raw HTTP client. `fetch` collapses a connection reset and a real
 * response into the same `TypeError`, which is exactly the distinction under
 * test — so we use `http.request` and report transport failures separately.
 *
 * @returns {Promise<{status: number, body: string}>}
 */
function request(method, urlPath, body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');

    const headers = { 'Content-Type': 'application/json' };
    /* Chunked encoding omits Content-Length, which forces the server down the
       streaming branch instead of the up-front header check. */
    if (chunked) headers['Transfer-Encoding'] = 'chunked';

    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }
    );

    req.on('error', (error) => reject(new Error(`transport failure: ${error.code || error.message}`)));
    req.end(payload);
  });
}

/** A body guaranteed to exceed the cap, as valid JSON. */
function oversizeBody() {
  const filler = 'x'.repeat(MAX_BODY_BYTES);
  return JSON.stringify({ members: [], filler });
}

test('oversize body gets 413 with a parseable JSON error, not a reset', async () => {
  /* Content-Length path: the header declares the violation, so the server
     refuses without buffering the body. */
  const { status, body } = await request('PUT', '/api/tree', oversizeBody());

  assert.equal(status, 413);
  assert.deepEqual(JSON.parse(body), { error: 'Payload too large.' });
});

test('oversize chunked body gets 413 once the cap is crossed mid-stream', async () => {
  /* No Content-Length to inspect, so the limit can only be detected while
     reading — this is the exact path that used to reset the connection. */
  const { status, body } = await request('PUT', '/api/tree', oversizeBody(), { chunked: true });

  assert.equal(status, 413);
  assert.deepEqual(JSON.parse(body), { error: 'Payload too large.' });
});

test('a refused save leaves the stored file untouched', async () => {
  const good = JSON.stringify({
    members: [{ id: 'a', name: 'Ada', sex: 'female', spouseIds: [], parentIds: [], childIds: [] }]
  });

  const saved = await request('PUT', '/api/tree', good);
  assert.equal(saved.status, 200);

  const before = await fsp.readFile(DATA_FILE, 'utf8');
  const backupsBefore = await fsp.readdir(BACKUP_DIR).catch(() => []);

  const refused = await request('PUT', '/api/tree', oversizeBody());
  assert.equal(refused.status, 413);

  assert.equal(await fsp.readFile(DATA_FILE, 'utf8'), before, 'data file must not change');

  const backupsAfter = await fsp.readdir(BACKUP_DIR).catch(() => []);
  assert.equal(backupsAfter.length, backupsBefore.length, 'refusal must not burn a backup slot');
});

test('the server still serves requests after refusing an oversize body', async () => {
  // A mishandled refusal used to leave the connection in a bad state.
  await request('PUT', '/api/tree', oversizeBody()).catch(() => {});

  const { status, body } = await request('GET', '/api/tree');
  assert.equal(status, 200);
  assert.ok(Array.isArray(JSON.parse(body).members));
});

test('a body just under the cap is still accepted', async () => {
  /* Guards the other direction: the fix must not start rejecting legitimate
     large-but-valid trees. Size is accumulated per member rather than by
     re-stringifying the whole array each pass, which would be quadratic. */
  const target = MAX_BODY_BYTES - 256 * 1024;
  const members = [];
  let size = Buffer.byteLength('{"members":[]}');

  while (size < target) {
    const id = `m${members.length}`;
    const member = {
      id,
      name: `Member ${id}`,
      sex: 'other',
      spouseIds: [],
      parentIds: [],
      childIds: []
    };
    members.push(member);
    size += Buffer.byteLength(JSON.stringify(member)) + 1; // +1 for the comma
  }

  const payload = JSON.stringify({ members });
  assert.ok(Buffer.byteLength(payload) < MAX_BODY_BYTES, 'fixture must be under the cap');

  const { status, body } = await request('PUT', '/api/tree', payload);
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).count, members.length);
});

test('dob values round-trip through the server without being dropped', async () => {
  const dob = '1998-06-15';
  const payload = JSON.stringify({
    members: [{
      id: 'dob-member',
      name: 'DOB Person',
      sex: 'female',
      dob,
      spouseIds: [],
      parentIds: [],
      childIds: []
    }]
  });

  const saved = await request('PUT', '/api/tree', payload);
  assert.equal(saved.status, 200);

  const loaded = await request('GET', '/api/tree');
  assert.equal(loaded.status, 200);
  assert.equal(JSON.parse(loaded.body).members[0].dob, dob);
});

test('occupation details round-trip through the server without being dropped', async () => {
  const payload = JSON.stringify({
    members: [{
      id: 'occupation-member',
      name: 'Occupation Person',
      sex: 'male',
      occupation: {
        company: 'Acme Labs',
        designation: 'Senior Engineer',
        salary: 85000
      },
      spouseIds: [],
      parentIds: [],
      childIds: []
    }]
  });

  const saved = await request('PUT', '/api/tree', payload);
  assert.equal(saved.status, 200);

  const loaded = await request('GET', '/api/tree');
  assert.equal(loaded.status, 200);
  const member = JSON.parse(loaded.body).members.find((item) => item.id === 'occupation-member');
  assert.deepEqual(member.occupation, {
    company: 'Acme Labs',
    designation: 'Senior Engineer',
    salary: 85000
  });
});
