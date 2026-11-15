const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const web = path.resolve(__dirname, '../../internal/web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(web, 'assets/app.js'), 'utf8');

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('UI state did not update');
}

function queryPage(kind) {
  const dom = new JSDOM(html, { url: 'https://bank.example/', runScripts: 'outside-only' });
  const window = dom.window;
  let question = {
    id: 11, course_id: 1, type: kind, stem: '测试题目',
    options: [{ key: 'A', text: kind === 'judgement' ? '正确' : '选项甲' }, { key: 'B', text: kind === 'judgement' ? '错误' : '选项乙' }],
    has_answer: false, conflict: false, answer_candidates: [], contributors: [],
  };
  const writes = [];
  let rejectWrites = false;
  window.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer UI-TEST-TOKEN');
    let data;
    if (options.method === 'POST') {
      assert.equal(url, '/api/v1/questions/batch');
      assert.equal(options.headers['Content-Type'], 'application/json');
      if (rejectWrites) return { ok: false, status: 401, json: async () => ({ error: { message: 'invalid Token' } }) };
      const body = JSON.parse(options.body);
      writes.push(body);
      const answers = body.questions[0].correct_answers;
      question = { ...question, has_answer: true, answer_candidates: [{ answer_keys: answers, answer_texts: answers.map(key => question.options.find(option => option.key === key).text), support_count: 1, contributors: [{ username: body.contributor.username, source_url: body.contributor.source_url }] }] };
      data = { received: 1 };
    } else if (url.startsWith('/api/v1/courses')) {
      data = { data: [{ id: 1, name: '测试课程', platform: '测试平台', external_id: 'test' }], total: 1 };
    } else if (url === '/api/v1/questions/11') data = { data: question };
    else data = { data: [question], total: 1 };
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  };
  window.eval(script);
  window.document.getElementById('token').value = 'UI-TEST-TOKEN';
  window.document.getElementById('login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, window, writes, rejectWrites() { rejectWrites = true; } };
}

for (const kind of ['single', 'multiple', 'judgement']) {
  test(`query UI manually saves ${kind} answers with Token and contributor`, async () => {
    const app = queryPage(kind);
    const doc = app.window.document;
    await waitFor(() => doc.querySelector('.manual-answer-form'));
    doc.querySelector('.manual-answer > button').click();
    const form = doc.querySelector('.manual-answer-form');
    assert.equal(form.hidden, false);
    const inputs = [...form.querySelectorAll('fieldset input')];
    assert(inputs.every(input => input.type === (kind === 'multiple' ? 'checkbox' : 'radio')));
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(app.writes.length, 0);
    assert.equal(form.querySelector('[role="alert"]').hidden, false);
    inputs[1].click();
    if (kind === 'multiple') inputs[0].click();
    form.querySelector('.manual-answer-author input').value = '手工贡献者';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !doc.getElementById('app-success').hidden);
    assert.equal(app.writes.length, 1);
    const body = app.writes[0];
    assert.equal(body.course_id, 1);
    assert.equal(body.contributor.username, '手工贡献者');
    assert.equal(body.contributor.source_url, 'https://bank.example/?question_id=11');
    assert.deepEqual(body.questions[0].correct_answers, kind === 'multiple' ? ['A', 'B'] : ['B']);
    assert(doc.querySelector('.question-card').textContent.includes('感谢 手工贡献者'));
    if (kind === 'judgement') assert(doc.querySelector('.question-card').textContent.includes('判断题'));
    app.dom.window.close();
  });
}

test('manual answer submission handles 401 by clearing the authenticated page', async () => {
  const app = queryPage('judgement');
  const doc = app.window.document;
  await waitFor(() => doc.querySelector('.manual-answer-form'));
  app.rejectWrites();
  const form = doc.querySelector('.manual-answer-form');
  form.querySelector('fieldset input').checked = true;
  form.querySelector('.manual-answer-author input').value = '贡献者';
  form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('app-view').hidden);
  assert.equal(doc.getElementById('question-list').children.length, 0);
  assert.equal(app.window.sessionStorage.getItem('course-bank-token'), null);
  app.dom.window.close();
});
