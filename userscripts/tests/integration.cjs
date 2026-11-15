// Real Go + SQLite + GM transport + JSDOM UI flow. Uses an isolated temp database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const binary = path.join(root, 'bin/questionbank');
const script = fs.readFileSync(path.join(root, 'userscripts/chaoxing-questionbank.user.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, label, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (condition()) return; await delay(20); }
  throw new Error(`Timed out: ${label}`);
}
function page(name, baseURL, token, prepare = () => {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.html`), 'utf8'), {
    url: 'https://mooc.private.example/mooc2/work/dowork?courseid=go-101&enc=PRIVATE', runScripts: 'outside-only',
  });
  const window = dom.window;
  prepare(window.document);
  let shadow, clipboard = '';
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  const messages = [];
  window.console.info = (...args) => messages.push(args.join(' '));
  window.console.error = (...args) => messages.push(args.join(' '));
  window.GM_getValue = () => ({ token, baseURL, interval: 0 });
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};
  window.GM_setClipboard = value => { clipboard = value; };
  window.TextEncoder = TextEncoder;
  window.GM_xmlhttpRequest = options => {
    const controller = new AbortController();
    fetch(options.url, { method: options.method, headers: options.headers, body: options.data, signal: controller.signal, redirect: 'error' })
      .then(async response => options.onload({ status: response.status, responseText: await response.text(), finalUrl: response.url }))
      .catch(error => error.name === 'AbortError' ? options.onabort() : options.onerror());
    return { abort: () => controller.abort() };
  };
  window.document.querySelectorAll('.answerBg').forEach(row => row.addEventListener('click', () => {
    if (row.getAttribute('role') === 'radio') row.parentElement.querySelectorAll('.answerBg').forEach(other => other.setAttribute('aria-checked', 'false'));
    row.setAttribute('aria-checked', String(row.getAttribute('aria-checked') !== 'true'));
  }));
  window.eval(script);
  return { dom, window, messages, get status() { return shadow.querySelector('.status').textContent; }, click(label) { [...shadow.querySelectorAll('button')].find(button => button.textContent === label).click(); }, get clipboard() { return clipboard; } };
}

(async () => {
  assert(fs.existsSync(binary), 'Build bin/questionbank first: go build -o bin/questionbank ./cmd/server');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'onlinecourse-userscript-'));
  const token = crypto.randomBytes(24).toString('hex');
  const configPath = path.join(folder, 'config.yaml');
  const config = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8')
    .replace(/^(\s*address:\s*).*$/m, '$1"127.0.0.1:0"')
    .replace(/^(\s*api_key:\s*).*$/m, (_, prefix) => prefix + JSON.stringify(token))
    .replace(/^(\s*path:\s*).*$/m, (_, prefix) => prefix + JSON.stringify(path.join(folder, 'bank.db')));
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  const server = spawn(binary, ['-config', configPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', baseURL = '';
  server.stdout.on('data', chunk => {
    output += chunk;
    const match = /address=(127\.0\.0\.1:\d+)/.exec(output);
    if (match) baseURL = `http://${match[1]}`;
  });
  server.stderr.on('data', chunk => { output += chunk; });
  const pages = [];
  try {
    await waitFor(() => baseURL, 'server listening');
    const install = await fetch(`${baseURL}/userscripts/chaoxing-questionbank.user.js`);
    assert.equal(install.status, 200);
    const body = await install.text();
    assert(body.startsWith('// ==UserScript==')); assert(!body.includes(token));
    assert.equal((await fetch(`${baseURL}/api/v1/courses`)).status, 401);

    const legacy = page('legacy', baseURL, token); pages.push(legacy);
    assert(legacy.status.includes('识别 2 题'));
    legacy.click('上传采集');
    await waitFor(() => /上传完成|操作已停止|返回 HTTP|网络请求失败/u.test(legacy.status), 'upload');
    assert(legacy.status.includes('上传完成'), legacy.status);
    legacy.click('上传采集');
    await waitFor(() => legacy.status.includes('上传完成'), 'duplicate upload');
    assert(legacy.status.includes('新增题目 0'), legacy.status);

    const modern = page('modern', baseURL, token); pages.push(modern);
    modern.click('查询并填写');
    await waitFor(() => modern.status.startsWith('完成：'), 'lookup and fill');
    assert(modern.status.includes('填写/一致 2 题'), modern.status);
    const checked = selector => [...modern.window.document.querySelectorAll(selector)].map(row => row.getAttribute('aria-checked'));
    assert.deepEqual(checked('#modern-single .answerBg'), ['false', 'true']);
    assert.deepEqual(checked('#modern-multiple .answerBg'), ['true', 'false', 'true']);
    modern.click('复制诊断');
    assert(modern.clipboard.includes('questionCount')); assert(!modern.clipboard.includes(token));
    assert(!modern.messages.join('\n').includes(token));

    const judgement = page('judgement', baseURL, token);
    pages.push(judgement);
    judgement.click('上传采集');
    await waitFor(() => judgement.status.includes('上传完成'), 'judgement upload');
    const reordered = page('judgement', baseURL, token, document => {
      for (const selector of ['#judgement-true ul', '#judgement-false .stem_answer']) {
        const container = document.querySelector(selector);
        container.append(...[...container.children].reverse());
      }
      document.querySelectorAll('#judgement-false .answer_p').forEach(node => {
        node.textContent = node.textContent === 'true' ? '对' : '错';
      });
    });
    pages.push(reordered);
    reordered.click('查询并填写');
    await waitFor(() => reordered.status.startsWith('完成：'), 'judgement lookup and fill');
    assert(reordered.status.includes('填写/一致 2 题'), reordered.status);
    assert.equal(reordered.window.document.getElementById('j31true').checked, true);
    assert.deepEqual(
      [...reordered.window.document.querySelectorAll('#judgement-false .answerBg')].map(row => row.getAttribute('aria-checked')),
      ['true', 'false'],
    );

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const courses = await (await fetch(`${baseURL}/api/v1/courses`, { headers })).json();
    const courseID = courses.data[0].id;
    const manualSeed = await (await fetch(`${baseURL}/api/v1/questions/batch`, {
      method: 'POST', headers,
      body: JSON.stringify({
        course_id: courseID,
        contributor: { username: '采集者', source_url: 'https://course.example/work' },
        questions: [{
          type: 'judgement', stem: '用于测试手动设置答案的判断题。',
          options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
        }],
      }),
    })).json();
    const manualID = manualSeed.data[0].question_id;
    const query = new JSDOM(fs.readFileSync(path.join(root, 'internal/web/index.html'), 'utf8'), {
      url: baseURL, runScripts: 'outside-only',
    });
    pages.push({ dom: query });
    query.window.AbortController = AbortController;
    query.window.fetch = (url, options) => fetch(new URL(url, baseURL), {
      ...options, headers: { ...options.headers, Origin: baseURL },
    });
    const queryDocument = query.window.document;
    query.window.eval(fs.readFileSync(path.join(root, 'internal/web/assets/app.js'), 'utf8'));
    queryDocument.getElementById('token').value = token;
    queryDocument.getElementById('login-form').dispatchEvent(new query.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => queryDocument.querySelectorAll('.question-card').length === 5, 'query UI');
    const card = [...queryDocument.querySelectorAll('.question-card')].find(node => node.querySelector('.question-id').textContent === `#${manualID}`);
    card.querySelector('.manual-answer > button').click();
    const form = card.querySelector('.manual-answer-form');
    form.querySelector('input[value="B"]').click();
    form.querySelector('.manual-answer-author input').value = '手动维护者';
    form.dispatchEvent(new query.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !queryDocument.getElementById('app-success').hidden, 'manual answer save');
    const saved = await (await fetch(`${baseURL}/api/v1/questions/${manualID}`, { headers })).json();
    assert.deepEqual(saved.data.answer_candidates[0].answer_keys, ['B']);
    assert.equal(saved.data.answer_candidates[0].contributors[0].username, '手动维护者');
    queryDocument.getElementById('question-type').value = 'judgement';
    queryDocument.getElementById('question-type').dispatchEvent(new query.window.Event('change', { bubbles: true }));
    await waitFor(() => queryDocument.querySelectorAll('.question-card').length === 3, 'judgement filter');
    assert([...queryDocument.querySelectorAll('.question-card')].every(node => node.textContent.includes('判断题')));

    const wrong = page('modern', baseURL, 'invalid-test-token'); pages.push(wrong);
    wrong.click('查询答案');
    await waitFor(() => wrong.status.includes('Token 无效'), '401 handling');
    assert(wrong.window.document.querySelectorAll('[aria-checked="true"]').length === 0);
    assert(!output.includes(token));
    console.log('Integration passed: authenticated upload/dedup, reordered single/multiple/judgement filling, manual answer save with attribution, judgement filtering and 401 handling; isolated SQLite.');
  } finally {
    pages.forEach(item => item.dom.window.close());
    if (server.exitCode === null) server.kill('SIGTERM');
    try { await waitFor(() => server.exitCode !== null, 'server shutdown', 5000); }
    catch { server.kill('SIGKILL'); await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'server termination', 2000); }
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
