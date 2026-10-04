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

  // 1. create + populate a quiz --------------------------------------------
  const created = await api('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 'E2E Quiz' }) });
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
