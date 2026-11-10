const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const core = require('../chaoxing-questionbank.user.js');

function fixture(name = 'legacy') {
  return new JSDOM(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.html`), 'utf8'), {
    url: 'https://mooc.private.example/mooc2/work/dowork?courseid=go-101&enc=SECRET&token=SECRET',
    runScripts: 'outside-only',
  });
}
function resultFor(question, keys) {
  return { match: 'exact', data: { type: question.type, stem: question.stem, has_answer: true, conflict: false,
    answer_candidates: [{ answer_keys: keys, answer_texts: keys.map(key => question.options.find(option => option.key === key).text), contributors: [{ username: '小明' }], support_count: 1 }] } };
}
function customClicks(document) {
  document.querySelectorAll('.answerBg').forEach(row => row.addEventListener('click', () => {
    if (row.getAttribute('role') === 'radio') row.parentElement.querySelectorAll('.answerBg').forEach(other => other.setAttribute('aria-checked', 'false'));
    row.setAttribute('aria-checked', String(row.getAttribute('aria-checked') !== 'true'));
  }));
}

test('legacy: extract course, user, questions and visible correct answers, not my answers', () => {
  const dom = fixture();
  const result = core.scan(dom.window.document);
  assert.equal(result.questions.length, 2);
  assert.equal(result.issues.length, 0);
  const [single, multi] = result.questions;
  assert.equal(single.stem, 'Go 声明函数的关键字是？');
  assert.equal(single.context.courseName, 'Go 语言基础');
  assert.equal(single.context.externalID, 'go-101');
  assert.equal(single.context.username, '小明');
  assert.deepEqual(single.correct_answers, ['A']);
  assert.deepEqual(multi.correct_answers, ['A', 'B']);
  assert.equal(single.source_url, 'https://mooc.private.example/mooc2/work/dowork?courseid=go-101');
  assert.deepEqual(Object.keys(core.payload(single)).sort(), ['correct_answers', 'options', 'stem', 'type']);
  dom.window.close();
});

test('work page: extract the top-left course header rather than the assignment title', () => {
  const dom = fixture();
  const doc = dom.window.document;
  doc.querySelector('.courseName').remove();
  doc.body.insertAdjacentHTML('afterbegin', `
    <div class="c-header"><div class="headerwrap">
      <div class="c-menu">首页 任务 作业</div>
      <h1><a href="/course/ai">人工智能</a> <a href="/course/evaluate"><span>课程评价</span></a></h1>
    </div></div>
    <h1>2026年秋季人工智能</h1>
  `);
  assert(core.scan(doc).questions.every(question => question.context.courseName === '人工智能'));
  assert.equal(doc.querySelector('.headerwrap h1 a:last-child').textContent, '课程评价');
  doc.querySelector('.headerwrap h1').setAttribute('title', '人工智能基础');
  doc.querySelector('.headerwrap h1 a').textContent = '人工智能…';
  assert.equal(core.detectContext(doc).courseName, '人工智能基础');
  dom.window.close();
});

test('course header: exclude evaluation controls while preserving the actual course name', () => {
  const dom = fixture();
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('afterbegin', '<div class="c-header"><div class="headerwrap"><h1></h1></div></div>');
  const heading = doc.querySelector('.headerwrap h1');
  for (const markup of [
    '人工智能 <a href="/evaluate">课程评价</a>',
    '<span>人工智能</span> <button>课程评价</button>',
    '<a href="/course/ai">人工智能</a> <span role="button">课程评价</span>',
  ]) {
    heading.innerHTML = markup;
    assert.equal(core.detectContext(doc).courseName, '人工智能');
  }
  heading.innerHTML = '<a href="/course/evaluation">课程评价方法</a> <a href="/evaluate">课程评价</a>';
  assert.equal(core.detectContext(doc).courseName, '课程评价方法');
  dom.window.close();
});

test('modern: skip outer wrapper, parse reordered options and multiple correct answers', () => {
  const dom = fixture('modern');
  const result = core.scan(dom.window.document);
  assert.equal(result.questions.length, 2);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.questions[0].correct_answers, ['B']);
  assert.deepEqual(result.questions[1].correct_answers, ['A', 'C']);
  assert.equal(result.questions[0].stem, 'Go 声明函数的关键字是？');
  dom.window.close();
});

test('hidden answers and existing selections never become correct answers', () => {
  const dom = fixture();
  const doc = dom.window.document;
  doc.querySelector('#question11 .Py_answer span').style.display = 'none';
  doc.querySelector('#q11b').checked = true;
  doc.querySelector('#question12 .Py_answer').hidden = true;
  const result = core.scan(doc);
  assert.deepEqual(result.questions[0].correct_answers, []);
  assert.deepEqual(result.questions[1].correct_answers, []);
  dom.window.close();
});

test('native controls: fill radio and multiple choice through label clicks, idempotently, without submit', async () => {
  const dom = fixture();
  let submits = 0, changes = 0;
  dom.window.document.querySelector('form').addEventListener('submit', event => { submits++; event.preventDefault(); });
  dom.window.document.querySelectorAll('input').forEach(input => input.addEventListener('change', () => changes++));
  const [single, multi] = core.scan(dom.window.document).questions;
  assert.equal((await core.fillQuestion(single, resultFor(single, ['A']), { delay: 0 })).status, 'filled');
  assert.equal((await core.fillQuestion(single, resultFor(single, ['A']), { delay: 0 })).status, 'unchanged');
  assert.equal((await core.fillQuestion(multi, resultFor(multi, ['A', 'B']), { delay: 0 })).status, 'filled');
  assert.equal(dom.window.document.querySelector('#q12c').checked, false);
  assert.equal(changes, 3);
  assert.equal(submits, 0);
  dom.window.close();
});

test('custom controls: correct single and multiple selection, preserve existing answers unless configured', async () => {
  const dom = fixture('modern'); customClicks(dom.window.document);
  const [single, multi] = core.scan(dom.window.document).questions;
  single.options[0].row.setAttribute('aria-checked', 'true');
  await assert.rejects(core.fillQuestion(single, resultFor(single, ['B']), { delay: 0 }), /已有选择/);
  await core.fillQuestion(single, resultFor(single, ['B']), { overwrite: true, delay: 0 });
  assert.deepEqual(single.options.map(core.selected), [false, true]);
  multi.options[1].row.setAttribute('aria-checked', 'true');
  await core.fillQuestion(multi, resultFor(multi, ['A', 'C']), { overwrite: true, delay: 0 });
  assert.deepEqual(multi.options.map(core.selected), [true, false, true]);
  dom.window.close();
});

test('fail before clicking on answer conflict, text mismatch, changed page or disabled input', async () => {
  const dom = fixture(); const q = core.scan(dom.window.document).questions[0];
  const conflict = resultFor(q, ['A']); conflict.data.conflict = true;
  await assert.rejects(core.fillQuestion(q, conflict), /冲突/);
  const mismatch = resultFor(q, ['A']); mismatch.data.answer_candidates[0].answer_texts[0] = 'wrong';
  await assert.rejects(core.fillQuestion(q, mismatch), /不一致/);
  const result = resultFor(q, ['A']); q.root.querySelector('.fontLabel').textContent = '改变后的题目';
  await assert.rejects(core.fillQuestion(q, result), /已变化/);
  assert(q.options.every(option => !core.selected(option)));
  dom.window.close();
  const other = fixture(); const disabled = core.scan(other.window.document).questions[0];
  disabled.options[0].input.disabled = true;
  await assert.rejects(core.fillQuestion(disabled, resultFor(disabled, ['A'])), /不可编辑/);
  other.window.close();
});

test('unresponsive custom controls never report a successful fill', async () => {
  const dom = fixture('modern'); const q = core.scan(dom.window.document).questions[0];
  await assert.rejects(core.fillQuestion(q, resultFor(q, ['B']), { delay: 0 }), /未通过校验/);
  dom.window.close();
});

test('unsupported type, duplicate options, images and obfuscated fonts are diagnosed', () => {
  for (const modify of [
    doc => { doc.querySelector('#answertype11').value = '3'; },
    doc => { doc.querySelector('#q11b').closest('li').querySelector('.after').textContent = 'func'; },
    doc => { doc.querySelector('#question11 .fontLabel').appendChild(doc.createElement('img')); },
    doc => { doc.querySelector('#question11 .fontLabel').classList.add('font-cxsecret'); },
  ]) {
    const dom = fixture(); modify(dom.window.document);
    const result = core.scan(dom.window.document);
    assert.equal(result.questions.length, 1);
    assert.equal(result.issues.length, 1);
    dom.window.close();
  }
});

test('same-origin frames are scanned once, including frames loaded after initial scan', () => {
  const dom = fixture();
  const iframe = dom.window.document.createElement('iframe'); dom.window.document.body.append(iframe);
  iframe.contentDocument.body.innerHTML = '<span>尚无题目</span>';
  assert.equal(core.scan(dom.window.document).questions.length, 2);
  iframe.contentDocument.body.innerHTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy.html'), 'utf8');
  const result = core.scan(dom.window.document);
  assert.equal(result.questions.length, 4); assert.equal(result.documents, 2);
  dom.window.close();
});

test('answer parsing is strict and configurable selectors are validated', () => {
  const options = [{ key: 'A', text: 'int' }, { key: 'B', text: 'varchar' }, { key: 'C', text: 'string' }];
  assert.deepEqual(core.parseChoiceAnswer('正确答案：AC 我的答案：B', options, 'multiple'), ['A', 'C']);
  assert.deepEqual(core.parseChoiceAnswer('A、C', options, 'single'), []);
  assert.deepEqual(core.parseChoiceAnswer('未知答案', options, 'multiple'), []);
  assert.deepEqual(core.parseChoiceAnswer('AA', options, 'multiple'), []);
  assert.deepEqual(core.parseChoiceAnswer('int\nstring', options, 'multiple'), ['A', 'C']);
  assert.deepEqual(core.parseChoiceAnswer('B', [{ key: 'A', text: 'B' }, { key: 'B', text: 'A' }], 'single'), ['B']);
  const dom = fixture();
  assert.deepEqual(core.validateSelectors('{"roots":".TiMu"}', dom.window.document), { roots: '.TiMu' });
  assert.throws(() => core.validateSelectors('{"password":"input"}', dom.window.document));
  assert.throws(() => core.validateSelectors('{"roots":"["}', dom.window.document));
  dom.window.close();
});

test('UTF-8 upload batches fit limits and preserve sources', () => {
  const dom = fixture(); const q = core.scan(dom.window.document).questions[0];
  const records = Array.from({ length: 105 }, () => q);
  const parts = core.batches(records, 1, '小明', 2000);
  assert.equal(parts.reduce((n, batch) => n + batch.questions.length, 0), 105);
  assert(parts.every(batch => batch.questions.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) <= 2000));
  assert.throws(() => core.batches([q], 1, '小明', 100), /体积/);
  dom.window.close();
});

test('GM transport sends Token only to configured backend, rejects redirects and exposes no Token on errors', async () => {
  const config = core.connection('http://127.0.0.1:8080/', 'TEST-SECRET');
  const gm = options => {
    assert.equal(options.url, 'http://127.0.0.1:8080/api/v1/courses');
    assert.equal(options.headers.Authorization, 'Bearer TEST-SECRET');
    assert.equal(options.anonymous, true); assert.equal(options.redirect, 'error');
    queueMicrotask(() => options.onload({ status: 200, responseText: '{"data":[]}', finalUrl: options.url }));
    return { abort() {} };
  };
  assert.deepEqual(await core.request(gm, config, 'GET', '/courses'), { data: [] });
  await assert.rejects(core.request(options => { queueMicrotask(() => options.onload({ status: 401, responseText: 'TEST-SECRET' })); }, config, 'GET', '/courses'), error => error.status === 401 && !error.message.includes('TEST-SECRET'));
  await assert.rejects(core.request(options => { queueMicrotask(() => options.onload({ status: 200, finalUrl: 'https://elsewhere.example/', responseText: '{}' })); }, config, 'GET', '/courses'), /重定向/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(core.request(gm, config, 'GET', '/courses', undefined, abort.signal), { name: 'AbortError' });
  assert.throws(() => core.connection('https://user:password@example.com', 'x'));
  assert.throws(() => core.connection('http://127.0.0.1', ''));
});

test('runtime panel boots without network and diagnostics/GM storage contain no accidental DOM Token leak', async () => {
  const dom = fixture(); const window = dom.window;
  let shadow;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  let requests = 0, diagnostic = '';
  window.GM_getValue = () => ({ token: 'TEST-SECRET', baseURL: 'http://127.0.0.1:8080' });
  window.GM_setValue = () => {};
  window.GM_xmlhttpRequest = () => { requests++; };
  window.GM_registerMenuCommand = () => {};
  window.GM_setClipboard = value => { diagnostic = value; };
  window.console.info = () => {};
  window.eval(fs.readFileSync(path.join(__dirname, '..', 'chaoxing-questionbank.user.js'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const host = window.document.getElementById('onlinecourse-chaoxing-panel');
  assert(host); assert.equal(host.shadowRoot, null); assert.equal(requests, 0);
  assert(!window.document.body.innerHTML.includes('TEST-SECRET'));
  assert.equal(shadow.querySelectorAll('.question').length, 2);
  [...shadow.querySelectorAll('button')].find(button => button.textContent === '复制诊断').click();
  assert(diagnostic.includes('questionCount')); assert(!diagnostic.includes('TEST-SECRET')); assert(!diagnostic.includes('小明'));
  dom.window.close();
});
