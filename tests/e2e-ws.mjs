// E2E: a full game — host + 3 players — against a running dev server.
// Prereq: `wrangler dev --port 8788` (or pass BASE_URL).
// Run: node tests/e2e-ws.mjs

import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788';
const WS_BASE = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

class Chan {
  constructor(url) {
    this.states = [];
    this.waiters = [];
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 8000);
      this.w = new WebSocket(url);
      this.w.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.w.onerror = () => reject(new Error('ws error'));
    });
    this.w.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t !== 'state') return;
      this.states.push(m.state);
      this.waiters = this.waiters.filter((h) => {
        if (h.pred(m.state)) {
          clearTimeout(h.timer);
          h.resolve(m.state);
          return false;
        }
        return true;
      });
    };
  }
  waitFor(pred, label, timeout = 9000) {
    const found = this.states.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), timeout);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
  close() {
    try {
      this.w.close();
    } catch {}
  }
}

const step = (name) => console.log(`  ✓ ${name}`);
let failed = false;
let host;
const chans = {};

try {
  console.log(`E2E against ${BASE}`);

  // 0. admin: setup/reset (POST /password works for both), then use the token
  const st0 = await api('/api/admin/status');
  assert.equal(st0.status, 200);
  const noCreate = await api('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 'Nope' }) });
  assert.equal(noCreate.status, 403, 'creating a quiz without the admin token is rejected');
  const weak = await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: 'short' }) });
  assert.equal(weak.status, 400, 'weak password rejected');
  const setup = await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: 'test-admin-pass' }) });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.token);
  const st1 = await api('/api/admin/status');
  assert.equal(st1.body.setup, false, 'after setup the password exists');
  const adminHeaders = { 'x-admin-token': setup.body.token };
  const badLogin = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  assert.equal(badLogin.status, 403);
  const goodLogin = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'test-admin-pass' }) });
  assert.equal(goodLogin.status, 200);
  step('admin: first-run setup, login, gating enforced');

  // 1. create + populate a quiz --------------------------------------------
  const created = await api('/api/quizzes', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: 'E2E Quiz' }) });
  assert.equal(created.status, 200);
  const { id, editToken } = created.body;
  assert.ok(id && editToken);

  const quiz = {
    title: 'E2E Quiz',
    questions: [
      { id: 'q1', type: 'choice', prompt: 'Capital of Japan?', options: ['Paris', 'Tokyo', 'Cairo'], correct: 1, timeLimitSec: 20 },
      { id: 'q2', type: 'truefalse', prompt: 'The sun is a star.', answer: true, timeLimitSec: 20 },
      { id: 'q3', type: 'short', prompt: 'Largest city in Japan?', accepted: ['Tokyo'], timeLimitSec: 30 },
      { id: 'q4', type: 'likert', prompt: 'How fun was that?', likertMin: 1, likertMax: 5, timeLimitSec: 15 },
      { id: 'q5', type: 'likert', prompt: 'Rate the snacks (4-5 acceptable)', likertMin: 1, likertMax: 5, correctValues: [4, 5], timeLimitSec: 15 },
      { id: 'q6', type: 'short', prompt: 'Say anything at all', accepted: [], acceptAny: true, timeLimitSec: 20 },
    ],
  };
  const saved = await api(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ token: editToken, quiz }) });
  assert.equal(saved.status, 200);
  step('quiz created and saved');

  // 2. reject bad saves ------------------------------------------------------
  const badSave = await api(`/api/quizzes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ token: editToken, quiz: { title: 'X', questions: [] } }),
  });
  assert.equal(badSave.status, 400);
  const wrongToken = await api(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ token: 'nope', quiz }) });
  assert.equal(wrongToken.status, 403);
  step('validation + auth enforced on save');

  // 3. go live ---------------------------------------------------------------
  const started = await api(`/api/quizzes/${id}/sessions`, { method: 'POST', body: JSON.stringify({ token: editToken }) });
  assert.equal(started.status, 200);
  const { code, hostToken } = started.body;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.ok(started.body.joinUrl.includes(code));
  step(`session started, code ${code}`);

  const summary = await api(`/api/sessions/${code}`);
  assert.equal(summary.body.exists, true);
  assert.equal(summary.body.phase, 'lobby');
  assert.equal(summary.body.title, 'E2E Quiz');

  // 4. players join ----------------------------------------------------------
  const players = {};
  for (const name of ['Alice', 'Bob', 'Carol']) {
    const j = await api(`/api/sessions/${code}/join`, { method: 'POST', body: JSON.stringify({ name }) });
    assert.equal(j.status, 200, `join ${name}`);
    players[name] = j.body;
  }
  step('3 players joined');

  const host0 = new Chan(`${WS_BASE}/ws/${code}?h=${hostToken}`);
  await host0.opened;
  host = host0;
  for (const [name, p] of Object.entries(players)) {
    const c = new Chan(`${WS_BASE}/ws/${code}?p=${p.playerToken}`);
    await c.opened;
    chans[name] = c;
  }
  await host.waitFor((s) => s.players.length === 3, '3 players visible');
  step('websockets connected, lobby state pushed');

  // 5. Q1 choice: speed-decayed scoring --------------------------------------
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'start' }) });
  const q1 = await chans.Alice.waitFor((s) => s.phase === 'question' && s.questionIndex === 0, 'Q1 open');
  assert.equal(q1.question.type, 'choice');
  assert.deepEqual(q1.question.options, ['Paris', 'Tokyo', 'Cairo']);
  assert.equal(q1.question.correct, undefined); // no answer key leaks
  step('Q1 (choice) live, options pushed, no leak');

  // editing is locked while the session is live
  const locked = await api(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ token: editToken, quiz }) });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, code);
  const quizView = await api(`/api/quizzes/${id}?token=${editToken}`);
  assert.deepEqual(quizView.body.live, { code });
  step('editing locked during live session');

  const ans = (name, answer) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex: 0, answer }) });
  await ans('Alice', { kind: 'choice', option: 1 }); // correct, instant
  await ans('Carol', { kind: 'choice', option: 0 }); // wrong, instant
  await sleep(1500);
  await ans('Bob', { kind: 'choice', option: 1 }); // correct, late

  const rev1 = await chans.Alice.waitFor((s) => s.phase === 'reveal', 'Q1 auto-reveal');
  assert.equal(rev1.reveal.correctLabel, 'Tokyo');
  assert.deepEqual(rev1.reveal.rows.map((r) => r.count), [1, 2, 0]);
  const sc = (name) => rev1.players.find((p) => p.name === name).score;
  assert.ok(sc('Alice') > sc('Bob'), 'faster correct answer scores higher');
  assert.ok(sc('Alice') <= 1000 && sc('Alice') >= 950, `alice near-instant ~1000, got ${sc('Alice')}`);
  assert.ok(sc('Bob') >= 900 && sc('Bob') < sc('Alice'), `bob late correct, got ${sc('Bob')}`);
  assert.equal(sc('Carol'), 0);
  assert.equal(rev1.you.lastCorrect, true);
  assert.equal(rev1.you.lastGained, sc('Alice'));
  step(`Q1 scored with decay (A=${sc('Alice')} B=${sc('Bob')} C=0)`);

  // double-answer rejected
  const dup = await ans('Alice', { kind: 'choice', option: 0 });
  assert.equal(dup.status, 409);
  step('double answering rejected');

  // 6. Q2 true/false ----------------------------------------------------------
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  await chans.Bob.waitFor((s) => s.phase === 'question' && s.questionIndex === 1, 'Q2 open');
  const ans2 = (name, value, qIndex = 1) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex, answer: { kind: 'truefalse', value } }) });
  await ans2('Alice', true);
  await ans2('Bob', false);
  await ans2('Carol', true);
  const rev2 = await chans.Carol.waitFor((s) => s.phase === 'reveal' && s.questionIndex === 1, 'Q2 reveal');
  assert.equal(rev2.reveal.correctLabel, 'True');
  step('Q2 (true/false) scored');

  // 7. Q3 short answer, normalized match --------------------------------------
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  await chans.Alice.waitFor((s) => s.phase === 'question' && s.questionIndex === 2, 'Q3 open');
  const ans3 = (name, text) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex: 2, answer: { kind: 'short', text } }) });
  await ans3('Alice', 'tokyo');
  await ans3('Bob', '  TOKYO.  ');
  await ans3('Carol', 'Osaka');
  const rev3 = await chans.Bob.waitFor((s) => s.phase === 'reveal' && s.questionIndex === 2, 'Q3 reveal');
  assert.deepEqual(rev3.reveal.rows.map((r) => r.count), [2, 1]);
  const s3 = (name) => rev3.players.find((p) => p.name === name).score;
  assert.equal(s3('Alice') - 1000, rev2.players.find((p) => p.name === 'Alice').score, 'flat +1000 for short');
  assert.equal(s3('Bob') - 1000, rev2.players.find((p) => p.name === 'Bob').score, 'bob matched despite case/space/punct');
  step('Q3 (short) normalized exact match');

  // 8. Q4 likert: unscored poll ------------------------------------------------
  const before = rev3.players.map((p) => p.score);
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  await chans.Alice.waitFor((s) => s.phase === 'question' && s.questionIndex === 3, 'Q4 open');
  const ans4 = (name, value) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex: 3, answer: { kind: 'likert', value } }) });
  await ans4('Alice', 5);
  await ans4('Bob', 3);
  await ans4('Carol', 1);
  const rev4 = await chans.Alice.waitFor((s) => s.phase === 'reveal' && s.questionIndex === 3, 'Q4 reveal');
  assert.equal(rev4.reveal.kind, 'likert');
  assert.equal(rev4.reveal.average, 3);
  const after = rev4.players.map((p) => p.score);
  assert.deepEqual(after, before, 'likert changes no scores');
  step('Q4 (likert) polled, unscored, average 3');

  // 8b. Q5 likert with marked correct values — scored like a real question
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  await chans.Alice.waitFor((s) => s.phase === 'question' && s.questionIndex === 4, 'Q5 open');
  const leakCheck = chans.Alice.states.find((s) => s.phase === 'question' && s.questionIndex === 4);
  assert.equal(leakCheck.question.correctValues, undefined); // no answer key leaks
  const ans5 = (name, value) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex: 4, answer: { kind: 'likert', value } }) });
  await ans5('Alice', 5);
  await ans5('Bob', 4);
  await ans5('Carol', 2);
  const rev5 = await chans.Alice.waitFor((s) => s.phase === 'reveal' && s.questionIndex === 4, 'Q5 reveal');
  assert.equal(rev5.reveal.correctLabel, '4 / 5');
  assert.deepEqual(rev5.reveal.rows.filter((r) => r.correct).map((r) => r.label), ['4', '5']);
  const s5 = (name) => rev5.players.find((p) => p.name === name).score;
  const before5 = rev4.players;
  assert.equal(s5('Alice') - 1000, before5.find((p) => p.name === 'Alice').score, 'alice +1000 for 5');
  assert.equal(s5('Bob') - 1000, before5.find((p) => p.name === 'Bob').score, 'bob +1000 for 4');
  assert.equal(s5('Carol'), before5.find((p) => p.name === 'Carol').score, 'carol 0 for 2');
  assert.equal(rev5.you.lastCorrect, true);
  step('Q5 (likert, marked 4/5) scored flat +1000');

  // 8c. Q6 short with accept-any — any non-empty text counts -------------------
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  await chans.Alice.waitFor((s) => s.phase === 'question' && s.questionIndex === 5, 'Q6 open');
  const leak6 = chans.Alice.states.find((s) => s.phase === 'question' && s.questionIndex === 5);
  assert.equal(leak6.question.acceptAny, undefined); // no key leak
  const ans6 = (name, text) => api(`/api/sessions/${code}/answer`, { method: 'POST', body: JSON.stringify({ playerToken: players[name].playerToken, qIndex: 5, answer: { kind: 'short', text } }) });
  await ans6('Alice', 'literally anything');
  await ans6('Bob', '42');
  await ans6('Carol', 'ตามใจเลย');
  const rev6 = await chans.Alice.waitFor((s) => s.phase === 'reveal' && s.questionIndex === 5, 'Q6 reveal');
  assert.deepEqual(rev6.reveal.rows.map((r) => r.count), [3, 0]);
  assert.equal(rev6.reveal.correctLabel, 'Any answer');
  assert.equal(rev6.reveal.accepted, undefined);
  for (const p of rev6.players) {
    assert.equal(p.score - 1000, rev5.players.find((x) => x.name === p.name).score, `${p.name} +1000 on accept-any`);
  }
  step('Q6 (short, accept-any) any text scored flat +1000');

  // 9. finish -------------------------------------------------------------------
  await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd: 'next' }) });
  const end = await chans.Alice.waitFor((s) => s.phase === 'ended', 'game ended');
  assert.equal(end.questionIndex, 6);
  const ranked = [...end.players].sort((a, b) => a.rank - b.rank);
  assert.equal(ranked[0].name, 'Alice');
  assert.ok(ranked[0].rank === 1);
  step(`game ended, podium: ${ranked.map((p) => `${p.rank}.${p.name}(${p.score})`).join(' ')}`);

  // 10. after end: editing unlocks; join rejected; state still readable ---------
  const unlock = await api(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ token: editToken, quiz }) });
  assert.equal(unlock.status, 200);
  const joinLate = await api(`/api/sessions/${code}/join`, { method: 'POST', body: JSON.stringify({ name: 'Late' }) });
  assert.equal(joinLate.status, 410);
  const pollState = await api(`/api/sessions/${code}/state?p=${players.Alice.playerToken}`);
  assert.equal(pollState.status, 200);
  assert.equal(pollState.body.phase, 'ended');
  step('post-game: edit unlocked, join closed, poll fallback works');

  // 11. auth on commands ---------------------------------------------------------
  const evil = await api(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken: 'evil', cmd: 'start' }) });
  assert.equal(evil.status, 403);
  step('host commands require the host token');

  // 12. durable records: sessions, players (IP), answers, scores ------------------
  await new Promise((r) => setTimeout(r, 1200)); // let the DO's D1 writes land
  const noAuth = await api('/api/admin/overview');
  assert.equal(noAuth.status, 403, 'admin overview requires the token');
  const ov = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(ov.status, 200);
  const sessRow = ov.body.sessions.find((s) => s.code === code);
  assert.ok(sessRow, 'session row recorded');
  assert.equal(sessRow.status, 'ended');
  assert.ok(sessRow.ended_at > 0, 'ended_at recorded');
  assert.equal(sessRow.title, 'E2E Quiz');
  const quizRow = ov.body.quizzes.find((q) => q.id === id);
  assert.ok(quizRow, 'quiz row visible to admin');
  const recPlayers = ov.body.players.filter((p) => p.session_code === code);
  assert.equal(recPlayers.length, 3, 'all 3 players recorded');
  const alice = recPlayers.find((p) => p.name === 'Alice');
  assert.ok(alice.score >= 4990 && alice.score <= 5000, `alice final score recorded (got ${alice.score})`);
  assert.ok(alice.ip, `player IP recorded (got ${JSON.stringify(alice.ip)})`);
  assert.ok(alice.user_agent, 'user agent recorded');
  const detail = await api(`/api/admin/sessions/${code}`, { headers: adminHeaders });
  assert.equal(detail.status, 200);
  const q1Answers = detail.body.answers.filter((a) => a.q_index === 0);
  assert.equal(q1Answers.length, 3, 'q1 answers recorded');
  const aliceQ1 = q1Answers.find((a) => a.name === 'Alice');
  assert.equal(aliceQ1.correct, 1);
  assert.equal(aliceQ1.gained, 1000);
  const carolQ1 = q1Answers.find((a) => a.name === 'Carol');
  assert.equal(carolQ1.correct, 0);
  assert.equal(carolQ1.gained, 0);
  const q4Answers = detail.body.answers.filter((a) => a.q_index === 3); // unscored likert
  assert.ok(q4Answers.every((a) => a.correct === null && a.gained === 0), 'unscored likert recorded with null outcome');
  step(`records: session+players(IP ${alice.ip})+answers written to SQLite`);

  // 12b. admin management: tokens exposed, delete session/quiz, live guard -----
  const q2 = await api('/api/quizzes', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: 'Deletable' }) });
  assert.equal(q2.status, 200);
  const savedQ2 = await api(`/api/quizzes/${q2.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      token: q2.body.editToken,
      quiz: { title: 'Deletable', questions: [{ id: 'd1', type: 'truefalse', prompt: 'P?', answer: true, timeLimitSec: 10 }] },
    }),
  });
  assert.equal(savedQ2.status, 200, 'quiz2 populated before going live');
  const ov2 = await api('/api/admin/overview', { headers: adminHeaders });
  const q2row = ov2.body.quizzes.find((q) => q.id === q2.body.id);
  assert.equal(q2row.edit_token, q2.body.editToken, 'overview exposes the edit token');
  const s2 = await api(`/api/quizzes/${q2.body.id}/sessions`, { method: 'POST', body: JSON.stringify({ token: q2.body.editToken }) });
  assert.equal(s2.status, 200);
  const ov3 = await api('/api/admin/overview', { headers: adminHeaders });
  const s2row = ov3.body.sessions.find((s) => s.code === s2.body.code);
  assert.equal(s2row.host_token, s2.body.hostToken, 'overview exposes the host token');

  // deleting a quiz with a live session is refused
  const delLive = await api(`/api/quizzes/${q2.body.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delLive.status, 409);
  assert.equal(delLive.body.code, s2.body.code);

  // force-delete the live session: rows + DO state gone
  const delSess = await api(`/api/sessions/${s2.body.code}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delSess.status, 200);
  const sum2 = await api(`/api/sessions/${s2.body.code}`);
  assert.equal(sum2.status, 404);
  assert.equal(sum2.body.exists, false, 'dropped session no longer exists');
  const ov4 = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(ov4.body.sessions.find((s) => s.code === s2.body.code), undefined, 'session row removed');
  assert.equal(ov4.body.players.filter((p) => p.session_code === s2.body.code).length, 0, 'session players removed');

  // now the quiz has no live session — delete succeeds and cascades.
  // (Question-image round-trip below runs first: quiz delete also 404s images.)
  const webpBytes = (n) => {
    const u = new Uint8Array(n);
    u.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    u.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    return u;
  };
  const q2edit = q2.body.editToken;
  const imgHeaders = { 'content-type': 'image/webp', 'x-edit-token': q2edit };

  const imgNoAuth = await api(`/api/quizzes/${q2.body.id}/images?w=320&h=240`, {
    method: 'POST',
    headers: { 'content-type': 'image/webp' },
    body: webpBytes(64),
  });
  assert.equal(imgNoAuth.status, 403, 'image upload requires the edit token');

  const badMagic = await api(`/api/quizzes/${q2.body.id}/images?w=320&h=240`, {
    method: 'POST',
    headers: { 'content-type': 'image/webp', 'x-edit-token': q2edit },
    body: new Uint8Array(Buffer.from('pretend this is a picture')),
  });
  assert.equal(badMagic.status, 400, 'non-image bytes rejected');

  const tooBig = await api(`/api/quizzes/${q2.body.id}/images?w=320&h=240`, {
    method: 'POST',
    headers: imgHeaders,
    body: webpBytes(600 * 1024),
  });
  assert.equal(tooBig.status, 413, 'oversize image rejected');

  const up1 = await api(`/api/quizzes/${q2.body.id}/images?w=320&h=240`, { method: 'POST', headers: imgHeaders, body: webpBytes(64) });
  assert.equal(up1.status, 200, 'upload ok');
  assert.ok(up1.body.id && up1.body.url === `/api/images/${up1.body.id}`);

  const served = await fetch(`${BASE}/api/images/${up1.body.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.match(served.headers.get('cache-control') ?? '', /immutable/);

  const savedWithImage = await api(`/api/quizzes/${q2.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      token: q2edit,
      quiz: {
        title: 'Deletable',
        questions: [{ id: 'd1', type: 'truefalse', prompt: 'P?', answer: true, timeLimitSec: 10, image: { id: up1.body.id, width: 320, height: 240 } }],
      },
    }),
  });
  assert.equal(savedWithImage.status, 200, 'save with image ref');
  const bogusRef = await api(`/api/quizzes/${q2.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      token: q2edit,
      quiz: {
        title: 'Deletable',
        questions: [{ id: 'd1', type: 'truefalse', prompt: 'P?', answer: true, timeLimitSec: 10, image: { id: 'nope123nope', width: 320, height: 240 } }],
      },
    }),
  });
  assert.equal(bogusRef.status, 400, 'unknown image reference rejected');

  // prune-on-save: an uploaded but unreferenced image is cleaned up
  const up2 = await api(`/api/quizzes/${q2.body.id}/images?w=100&h=80`, { method: 'POST', headers: imgHeaders, body: webpBytes(64) });
  assert.equal(up2.status, 200);
  const reSave = await api(`/api/quizzes/${q2.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      token: q2edit,
      quiz: {
        title: 'Deletable',
        questions: [{ id: 'd1', type: 'truefalse', prompt: 'P?', answer: true, timeLimitSec: 10, image: { id: up1.body.id, width: 320, height: 240 } }],
      },
    }),
  });
  assert.equal(reSave.status, 200);
  const prunedEarly = await fetch(`${BASE}/api/images/${up2.body.id}`);
  assert.equal(prunedEarly.status, 404, 'unreferenced image pruned by the save');
  const keptEarly = await fetch(`${BASE}/api/images/${up1.body.id}`);
  assert.equal(keptEarly.status, 200, 'referenced image survives the prune');
  const delQuiz = await api(`/api/quizzes/${q2.body.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delQuiz.status, 200);
  const ov5 = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(ov5.body.quizzes.find((q) => q.id === q2.body.id), undefined, 'quiz removed');
  step('admin: tokens exposed, live-guard 409, session+quiz delete cascade');

  // origin checks after the delete (cache-busting: the earlier GETs are
  // legitimately pinned in the edge cache as immutable)
  const pruned = await fetch(`${BASE}/api/images/${up2.body.id}?cb=${Date.now()}`);
  assert.equal(pruned.status, 404, 'unreferenced image pruned');
  const kept = await fetch(`${BASE}/api/images/${up1.body.id}?cb=${Date.now()}`);
  assert.equal(kept.status, 404, 'referenced image deleted with its quiz');
  step('images: auth+caps enforced, serve cached, prune-on-save, cascade');

  // 12c. any admin browser can open the editor + host screen (server-side links)
  const quiz1row = ov5.body.quizzes.find((q) => q.id === id);
  assert.ok(quiz1row.edit_token === editToken, 'quiz1 editable from any browser');
  const sess1row = ov5.body.sessions.find((s) => s.code === code);
  assert.ok(sess1row.host_token === hostToken, 'session1 host screen reachable from any browser');
  step('admin links carry edit/host tokens from the server');

  // 13. reset flow (?reset=1) invalidates the old token --------------------------
  const reset = await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: 'reset-pass-456' }) });
  assert.equal(reset.status, 200);
  const oldToken = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(oldToken.status, 403, 'old admin token invalidated by reset');
  const newTok = await api('/api/admin/overview', { headers: { 'x-admin-token': reset.body.token } });
  assert.equal(newTok.status, 200);
  step('admin reset issues a new token and revokes the old one');

  console.log('\nE2E PASSED ✅');
} catch (e) {
  failed = true;
  console.error('\nE2E FAILED ❌\n', e.message);
  process.exitCode = 1;
} finally {
  if (host) host.close();
  for (const c of Object.values(chans)) c?.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}
