// ==UserScript==
// @name         超星 MOOC · 私有题库采集与填写
// @namespace    onlinecourse.local
// @version      0.1.0
// @description  单选/多选采集、可见正确答案上传、私有题库查询与填写，保留贡献者鸣谢。
// @match        *://*.chaoxing.com/*
// @match        *://*/mycourse/*
// @match        *://*/mooc-ans/*
// @match        *://*/mooc2/*
// @match        *://*/work/*
// @match        *://*/exam-ans/*
// @match        *://*/exam/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

// Independently implemented DOM adapter. Selector references (no third-party code bundled):
// https://github.com/ocsjs/ocsjs/blob/5.0/packages/scripts/src/projects/cx.ts
// https://github.com/iPycc/Fk-Chaoxing-Extension/blob/main/modules/question/parse/homework.js
// https://github.com/ltxhhz/getChaoXingTopic/blob/master/export2.js
(() => {
  "use strict";
  const VERSION = "0.1.0";
  const HOST_ID = "onlinecourse-chaoxing-panel";
  const STORAGE_KEY = "onlinecourse-chaoxing-v1";
  const SELECTORS = {
    roots: [".questionLi", ".TiMu", ".singleQuesId"],
    stem: [".mark_name", ".Zy_TItle .fontLabel", ".Zy_Title .fontLabel", ".Zy_TItle .clearfix", ".Zy_TItle > div", ".newZy_TItle .fontLabel", ".Zy_TItle", ".Zy_Title", ":scope > h3", ".question-title"],
    options: [".stem_answer .answerBg", ".answerBg", "ul.Zy_ulTop > li", "ul li:has(label.after)", ".option-item"],
    optionText: [".answer_p", "label.after", ".after", ".option-content", ".option-text", "a"],
    correctAnswer: [".correctAnswer .answerCon", ".correctAnswer", ".Py_answer > span", ".Py_answer", ".correct-answer", ".rightAnswer"],
    courseName: ["#courseName", "#coursename", ".courseName", ".course-name", ".course_name", "input[name='courseName']"],
    username: ["#currentUserName", "#userName", ".userName", ".username", ".user-name", ".userInfo .name", ".head_name", "[data-user-name]"],
  };
  const TYPE_SELECTOR = "input[id^='answertype'],input[name^='answertype'],input[name^='type']:not([name='type']),[data-question-type]";
  const PRIVATE_SOURCE_KEYS = new Set(["courseid", "clazzid", "classid", "workid", "knowledgeid", "jobid", "id", "examid", "paperid"]);
  const normalize = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function fail(message) { throw new Error(message); }
  function selectorList(custom, key) {
    const value = custom[key] ?? SELECTORS[key];
    return Array.isArray(value) ? value : [value];
  }
  function first(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }
  function visible(node) {
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    }
    return true;
  }
  function text(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    const originals = [...node.querySelectorAll("*")];
    const copies = [...clone.querySelectorAll("*")];
    originals.forEach((original, index) => { if (!visible(original)) copies[index].remove(); });
    clone.querySelectorAll("script,style,input,button,textarea,[hidden],[aria-hidden='true'],.colorShallow,.question-score,.score,.question-type,.question-number").forEach((el) => el.remove());
    clone.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
    clone.querySelectorAll("p,div").forEach((el) => el.append("\n"));
    return clone.textContent || "";
  }
  function cleanStem(value) {
    let result = normalize(value);
    for (let i = 0; i < 3; i++) {
      result = result.replace(/^\d+\s*[.．、)）]\s*/u, "")
        .replace(/^[【[(（]\s*(?:单选|多选|单项选择|多项选择)题[^】\])）]*[】\])）]\s*/u, "");
    }
    return normalize(result.replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*$/u, ""));
  }
  function sourceURL(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) fail("来源页面不是 http(s) 地址");
    url.username = ""; url.password = ""; url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (!PRIVATE_SOURCE_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.href;
  }
  function documents(rootDocument) {
    const found = [], blocked = [];
    const seen = new Set();
    function walk(doc, depth) {
      if (!doc || seen.has(doc) || depth > 5) return;
      seen.add(doc); found.push(doc);
      for (const frame of doc.querySelectorAll("iframe,frame")) {
        try {
          const child = frame.contentDocument;
          if (child?.documentElement) { void child.defaultView.location.href; walk(child, depth + 1); }
          else blocked.push("存在未加载或跨域 iframe，请在该 frame 内启用脚本");
        } catch { blocked.push("存在跨域 iframe，请在该 frame 内启用脚本"); }
      }
    }
    walk(rootDocument, 0);
    return { found, blocked };
  }
  function readNode(node) {
    return normalize(node?.getAttribute("data-user-name") || node?.value || node?.getAttribute("title") || text(node));
  }
  function detectContext(doc, allDocuments = [doc], custom = {}) {
    const docs = [doc, ...allDocuments.filter((item) => item !== doc)];
    let externalID = "", courseName = "", username = "";
    for (const current of docs) {
      if (!externalID) {
        const params = new URL(current.URL).searchParams;
        for (const [key, value] of params) if (key.toLowerCase() === "courseid" && value) { externalID = value; break; }
        if (!externalID) externalID = readNode(first(current, ["#courseId", "#courseid", "input[name='courseId']", "input[name='courseid']"])) || "";
        if (!externalID) externalID = current.querySelector("[data-course-id]")?.getAttribute("data-course-id") || "";
      }
      if (!courseName) courseName = readNode(first(current, selectorList(custom, "courseName")));
    }
    // Header/user controls on the outer page are preferred over question markup.
    for (const current of allDocuments) {
      const candidate = readNode(first(current, selectorList(custom, "username")));
      if (candidate && !/^(?:登录|请登录|未登录|退出)$/u.test(candidate)) { username = candidate; break; }
    }
    return { externalID: normalize(externalID), courseName, username };
  }
  function questionType(root) {
    const metadata = root.querySelector(TYPE_SELECTOR);
    if (metadata) {
      const value = normalize(metadata.value || metadata.getAttribute("data-question-type"));
      if (["0", "single", "单选题"].includes(value)) return "single";
      if (["1", "multiple", "多选题"].includes(value)) return "multiple";
      if (value !== "") return null;
    }
    const heading = normalize(text(first(root, [".Zy_TItle", ".newZy_TItle", "h3", ".question-title"])));
    if (/(?:判断|填空|简答|论述|连线|阅读理解)题/u.test(heading)) return null;
    if (/(?:多选|多项选择)题/u.test(heading)) return "multiple";
    if (/(?:单选|单项选择)题/u.test(heading)) return "single";
    if (root.querySelector("input[type='checkbox']")) return "multiple";
    if (root.querySelector("input[type='radio']")) return "single";
    return null;
  }
  function parseChoiceAnswer(value, options, type) {
    let answer = String(value || "").trim();
    const labelled = /(?:正确答案|参考答案)\s*[:：]\s*([\s\S]*?)(?=(?:我的答案|您的答案|你的答案|答案解析|解析|得分|评分)\s*[:：]?|$)/u.exec(answer);
    if (labelled) answer = labelled[1].trim();
    const exact = options.find((option) => normalize(option.text) === normalize(answer));
    const letters = /^[A-Z](?:[\s,，、;；|/]*[A-Z])*$/iu.test(answer) ? answer.toUpperCase().replace(/[^A-Z]/gu, "").split("") : [];
    let keys;
    if (letters.length && letters.every((key) => options.some((option) => option.key === key))) keys = letters;
    else if (exact) keys = [exact.key];
    else {
      const pieces = answer.split(/[\n;；|]+/u).map(normalize).filter(Boolean);
      keys = pieces.map((piece) => options.find((option) => normalize(option.text) === piece)?.key);
    }
    if (!keys.length || keys.some((key) => !options.some((option) => option.key === key)) || new Set(keys).size !== keys.length || (type === "single" && keys.length !== 1)) return [];
    return options.filter((option) => keys.includes(option.key)).map((option) => option.key);
  }
  function correctAnswers(root, options, type, custom) {
    const answers = new Map();
    for (const selector of selectorList(custom, "correctAnswer")) {
      for (const node of root.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const value = text(node).trim();
        const explicit = custom.correctAnswer || node.matches(".correctAnswer, .correctAnswer .answerCon");
        if (!explicit && !/(?:正确答案|参考答案)\s*[:：]/u.test(value)) continue;
        const keys = parseChoiceAnswer(value, options, type);
        if (keys.length) answers.set(JSON.stringify(keys), keys);
      }
    }
    if (answers.size > 1) fail("页面显示的正确答案互相冲突，请检查答案选择器");
    return [...answers.values()][0] || [];
  }
  function extractQuestion(root, custom = {}) {
    const type = questionType(root);
    if (!type) fail("不支持或无法确认题型，仅采集单选和多选");
    const stemNode = first(root, selectorList(custom, "stem"));
    if (!stemNode) fail("未找到题干");
    const rows = (() => {
      for (const selector of selectorList(custom, "options")) {
        const candidates = [...root.querySelectorAll(selector)];
        if (candidates.length >= 2) return candidates;
      }
      return [];
    })();
    if (rows.length < 2 || rows.length > 26) fail("选项数量不在 2–26 范围");
    const optionNodes = rows.map((row) => first(row, selectorList(custom, "optionText")) || row);
    if ([stemNode, ...rows].some((node) => node.matches(".font-cxsecret") || node.querySelector(".font-cxsecret,img,svg,canvas,math,.katex,.MathJax"))) fail("题干/选项含图片、公式或 font-cxsecret 字体，当前版本跳过");
    const stem = cleanStem(text(stemNode));
    if (!stem || [...stem].length > 10000) fail("题干为空或超过 10000 字");
    const options = rows.map((row, index) => {
      const input = row.querySelector("input[type='radio'],input[type='checkbox']");
      const label = normalize(row.querySelector(".before,.option-key")?.textContent);
      const explicit = normalize(row.getAttribute("data-option-key") || input?.value || "");
      const key = /^[A-Z]$/iu.test(label) ? label.toUpperCase() : /^[A-Z]$/iu.test(explicit) ? explicit.toUpperCase() : String.fromCharCode(65 + index);
      const content = normalize(text(optionNodes[index]).replace(new RegExp(`^\\s*${key}[.．、:：)）]\\s*`, "u"), ""));
      if (!content || [...content].length > 5000) fail("选项文本为空或超过 5000 字");
      return { key, text: content, row, input, target: optionNodes[index] };
    });
    if (new Set(options.map((option) => option.key)).size !== options.length || new Set(options.map((option) => option.text)).size !== options.length) fail("选项编号或规范化文本重复");
    return { root, doc: root.ownerDocument, type, stem, options, correct_answers: correctAnswers(root, options, type, custom) };
  }
  function roots(doc, custom) {
    const candidates = [...new Set(selectorList(custom, "roots").flatMap((selector) => [...doc.querySelectorAll(selector)]))];
    return candidates.filter((root) => {
      const modern = root.closest(".questionLi");
      if (modern && modern !== root && candidates.includes(modern)) return false;
      if (root.matches(".questionLi")) return true;
      return !candidates.some((other) => other !== root && root.contains(other));
    });
  }
  function payload(question) {
    return { type: question.type, stem: question.stem, options: question.options.map(({ key, text: value }) => ({ key, text: value })), correct_answers: [...question.correct_answers] };
  }
  function signature(question) { const value = payload(question); delete value.correct_answers; return JSON.stringify(value); }
  function scan(rootDocument, custom = {}) {
    const contexts = documents(rootDocument);
    const questions = [], issues = contexts.blocked.map((reason) => ({ reason }));
    for (const doc of contexts.found) {
      for (const [index, root] of roots(doc, custom).entries()) {
        if (!visible(root)) continue;
        try {
          const question = extractQuestion(root, custom);
          const location = /^https?:/u.test(doc.URL) ? doc.URL : rootDocument.URL;
          question.source_url = sourceURL(location);
          question.context = detectContext(doc, contexts.found, custom);
          questions.push(question);
        } catch (error) { issues.push({ index: index + 1, reason: error.message }); }
      }
    }
    return { questions, issues, documents: contexts.found.length };
  }
  function selected(option) {
    const ariaNode = option.row.matches("[aria-checked]") ? option.row : option.row.querySelector("[aria-checked]");
    if (ariaNode) return ariaNode.getAttribute("aria-checked") === "true";
    if (option.input) return option.input.checked;
    if (option.row.matches(".answerBg,[role='radio'],[role='checkbox'],[onclick]") || option.target.hasAttribute("onclick")) {
      return option.row.matches(".checked,.selected,[class*='check_answer']") || Boolean(option.row.querySelector(".checked,.selected,[class*='check_answer']"));
    }
    return null;
  }
  function validatedCandidate(question, result) {
    if (result.match !== "exact" || !result.data?.has_answer) fail("题库未命中或暂无答案");
    if (result.data.conflict || result.data.answer_candidates?.length !== 1) fail("题库答案存在冲突，跳过填写");
    const candidate = result.data.answer_candidates[0];
    const keys = candidate.answer_keys;
    if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || (question.type === "single" && keys.length !== 1)) fail("题库返回的答案编号不合法");
    if (result.data.type !== question.type || normalize(result.data.stem) !== question.stem) fail("题库返回的题型或题干不一致");
    if (!Array.isArray(candidate.answer_texts) || candidate.answer_texts.length !== keys.length) fail("题库返回的答案文本不完整");
    keys.forEach((key, index) => {
      const option = question.options.find((item) => item.key === key);
      if (!option || normalize(candidate.answer_texts[index]) !== option.text) fail("题库答案与当前选项不一致");
    });
    return candidate;
  }
  async function fillQuestion(question, result, { overwrite = false, custom = {}, delay = 100 } = {}) {
    const candidate = validatedCandidate(question, result);
    if (!question.root.isConnected) fail("题目节点已被替换，请重新扫描");
    const current = extractQuestion(question.root, custom);
    if (signature(current) !== signature(question)) fail("页面题目已变化，请重新扫描");
    const keys = new Set(candidate.answer_keys);
    const states = current.options.map(selected);
    if (states.some((value) => value === null)) fail("无法确认选项控件状态，跳过填写");
    if (current.options.some((option) => option.input?.disabled || option.row.getAttribute("aria-disabled") === "true")) fail("题目控件不可编辑");
    if (states.every((value, index) => value === keys.has(current.options[index].key))) return { status: "unchanged", candidate };
    if (!overwrite && states.some(Boolean)) fail("题目已有选择，已保留原答案（可在设置中允许改写）");
    const click = async (option) => {
      // Chaoxing binds saving/selection logic to the displayed answer, not only
      // the native input. Preserve that click path when the markup identifies it.
      const platformTarget = option.target.matches(".answer_p,.after") || option.target.closest("label") || option.row.hasAttribute("onclick");
      (platformTarget ? option.target : option.input || option.target).click();
      await sleep(delay);
    };
    if (question.type === "multiple") {
      for (const option of current.options) if (selected(option) !== keys.has(option.key)) await click(option);
    } else {
      // Selecting the desired radio clears its group; never click unwanted radios.
      for (const option of current.options) if (option.input?.type === "checkbox" && selected(option) && !keys.has(option.key)) await click(option);
      const desired = current.options.find((option) => keys.has(option.key));
      if (!selected(desired)) await click(desired);
    }
    if (!current.options.every((option) => selected(option) === keys.has(option.key))) fail("点击后选中状态未通过校验，请手动检查当前题目");
    return { status: "filled", candidate };
  }
  function validateSelectors(value, doc) {
    const custom = typeof value === "string" ? JSON.parse(value || "{}") : value;
    if (!custom || Array.isArray(custom) || typeof custom !== "object") fail("选择器配置必须是 JSON 对象");
    for (const [key, list] of Object.entries(custom)) {
      if (!Object.hasOwn(SELECTORS, key)) fail(`未知适配配置：${key}`);
      const selectors = Array.isArray(list) ? list : [list];
      if (!selectors.length || selectors.some((item) => typeof item !== "string" || !item.trim())) fail(`选择器 ${key} 必须是非空字符串或数组`);
      for (const selector of selectors) doc.querySelector(selector);
    }
    return custom;
  }
  function connection(baseURL, token) {
    const url = new URL(baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("后端地址须为无帐号、查询参数和片段的 http(s) 地址");
    if (!token || /\s/u.test(token)) fail("请填写非空且不含空白的 Token");
    return { baseURL: url.href.replace(/\/+$/u, ""), token };
  }
  function request(gm, config, method, path, data, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("操作已停止", "AbortError"));
    return new Promise((resolve, reject) => {
      let settled = false, handle;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { handle?.abort(); finish(new DOMException("操作已停止", "AbortError")); };
      const timer = setTimeout(() => { finish(new Error("请求超时，请检查后端地址与 @connect 配置")); handle?.abort(); }, 18000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle = gm({ method, url: `${config.baseURL}/api/v1${path}`, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", Accept: "application/json" }, data: data === undefined ? undefined : JSON.stringify(data), anonymous: true, redirect: "error",
          onload: (response) => {
            try {
              if (response.finalUrl && new URL(response.finalUrl).origin !== new URL(config.baseURL).origin) fail("后端发生跨域重定向，请使用最终后端地址");
              if (response.status === 401) { const error = new Error("Token 无效，请修改设置；本次操作已停止"); error.status = 401; throw error; }
              if (response.status < 200 || response.status >= 300) {
                let code = "", requestID = "";
                try { const result = JSON.parse(response.responseText); code = result.error?.code || ""; requestID = result.error?.request_id || ""; } catch { /* Non-JSON proxy error. */ }
                fail(`接口 ${path} 返回 HTTP ${response.status}${code ? ` / ${code}` : ""}${requestID ? ` / request_id=${requestID}` : ""}`);
              }
              finish(null, JSON.parse(response.responseText));
            } catch (error) { finish(error); }
          },
          onerror: () => finish(new Error("网络请求失败，请检查后端、证书和油猴 @connect 权限")),
          ontimeout: () => finish(new Error("网络请求超时")),
          onabort: () => finish(new DOMException("操作已停止", "AbortError")),
        });
      } catch { finish(new Error("无法发起请求，请检查油猴权限与后端地址")); }
    });
  }
  function batches(questions, courseID, username, maxBytes = 1500 * 1024) {
    const result = [];
    for (const question of questions) {
      const item = payload(question);
      let batch = result.at(-1);
      if (!batch || batch.contributor.source_url !== question.source_url) {
        batch = { course_id: courseID, contributor: { username, source_url: question.source_url }, questions: [] };
        result.push(batch);
      }
      batch.questions.push(item);
      if (batch.questions.length > 100 || new TextEncoder().encode(JSON.stringify(batch)).length > maxBytes) {
        batch.questions.pop();
        if (!batch.questions.length) fail("单题数据超过上传体积限制");
        const next = { course_id: courseID, contributor: { username, source_url: question.source_url }, questions: [item] };
        if (new TextEncoder().encode(JSON.stringify(next)).length > maxBytes) fail("单题数据超过上传体积限制");
        result.push(next);
      }
    }
    return result;
  }

  const core = { VERSION, SELECTORS, normalize, cleanStem, sourceURL, detectContext, parseChoiceAnswer, extractQuestion, scan, selected, payload, validatedCandidate, fillQuestion, validateSelectors, connection, request, batches };
  if (typeof module === "object" && module.exports) { module.exports = core; return; }

  // The UI and extension storage stay in the userscript sandbox.
  if (typeof document !== "undefined") boot().catch(() => console.error("[题库][启动] 面板初始化失败，请检查脚本权限"));

  async function boot() {
    let doc = document;
    try {
      while (doc.defaultView.parent !== doc.defaultView) {
        const parent = doc.defaultView.parent.document;
        void parent.defaultView.location.href;
        doc = parent;
      }
    } catch { /* Cross-origin frames keep their own panel. */ }
    if (!doc.body || doc.getElementById(HOST_ID)) return;
    const host = doc.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(380px,calc(100vw - 24px));";
    const shadow = host.attachShadow({ mode: "closed" });
    doc.body.append(host);
    const stored = GM_getValue(STORAGE_KEY, {}) || {};
    const origin = new URL(doc.URL).origin;
    const site = stored.sites?.[origin] || {};
    let snapshot = { questions: [], issues: [], documents: 0 };
    let busy = false, controller = null;
    const resultRows = new Map();
    const el = (tag, value, className) => {
      const node = doc.createElement(tag);
      if (value !== undefined) node.textContent = value;
      if (className) node.className = className;
      return node;
    };
    const style = el("style", `
      :host{all:initial;font-family:system-ui,"PingFang SC",sans-serif;color:#183b35;font-size:12px;line-height:1.6}
      *{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:wait}
      input,textarea{width:100%;border:1px solid #dbe5df;border-radius:5px;padding:6px 8px;background:#fff;color:#24463b;min-width:0}
      input:focus,textarea:focus,button:focus-visible{outline:2px solid #66ac96;outline-offset:2px}input[type=checkbox]{width:auto;margin:0 7px 0 0}
      button{padding:6px 9px;border:1px solid #d5e2da;background:#fff;color:#2c5d49;border-radius:5px}button.primary{background:#13796e;border-color:#13796e;color:#fff}
      .panel{border:1px solid #bfd8c9;border-radius:11px;box-shadow:0 7px 35px #123d3430;background:#fff;overflow:hidden}
      header{background:#143d37;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:11px 13px;gap:10px}header strong{font-size:13px}header span{font-size:9px;color:#a3c4b6;margin-left:6px}header button{padding:1px 8px;background:#ffffff12;color:white;border:1px solid #ffffff25}
      .body{padding:12px;max-height:min(760px,calc(100vh - 90px));overflow:auto}p{margin:0 0 8px}.status{background:#edf6f1;border-radius:6px;padding:9px 10px;overflow-wrap:anywhere}.error{color:#b04435}.warn{color:#9e6d22}.success{color:#217450}
      details{border:1px solid #e0e8e2;border-radius:6px;margin:10px 0}summary{cursor:pointer;padding:8px 10px;color:#6a8474}.fields{padding:0 10px 10px;display:grid;gap:8px}label{display:grid;gap:3px;font-size:11px;color:#71897b}.check{display:flex;align-items:center}.hint{font-size:10px;color:#91a095}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0}.utility{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0}a{color:#13796e;text-decoration:underline;text-underline-offset:2px}.stop{border-color:#e5c9b6;color:#ad6642}.list{max-height:230px;overflow:auto}.question{border:1px solid #e0e8e3;border-radius:6px;padding:8px 9px;margin:7px 0}.question strong{font-size:11px;display:block;overflow-wrap:anywhere}.question p{margin:4px 0 0;font-size:10px;overflow-wrap:anywhere}.question .preview{color:#8a9d90}.logs{font:10px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:145px;overflow:auto;padding:8px;margin:0;color:#788f80}.foot{font-size:9px;color:#95a69b;margin-top:9px}.collapsed{display:none}
    `);
    const panel = el("section", undefined, "panel");
    panel.setAttribute("aria-label", "超星私有题库助手");
    const header = el("header");
    const title = el("div"); title.append(el("strong", "题库助手"), el("span", `超星 MOOC · ${VERSION}`));
    const collapse = el("button", "收起"); collapse.type = "button"; collapse.setAttribute("aria-expanded", "true");
    header.append(title, collapse);
    const body = el("div", undefined, "body");
    const status = el("p", "等待扫描当前页面…", "status"); status.setAttribute("role", "status");
    const settings = el("details"); settings.append(el("summary", "连接、课程与适配设置"));
    const fields = el("div", undefined, "fields");
    const inputs = {};
    function field(key, label, value, type = "text") {
      const wrapper = el("label", label);
      const input = el(type === "textarea" ? "textarea" : "input");
      if (type !== "textarea") input.type = type;
      input.value = value || ""; input.autocomplete = "off"; input.spellcheck = false;
      wrapper.append(input); fields.append(wrapper); inputs[key] = input;
      return input;
    }
    const detected = detectContext(doc, documents(doc).found, stored.selectors || {});
    const courseScope = detected.externalID ? `${origin}|${detected.externalID}` : "";
    const courseOverride = stored.courses?.[courseScope] || {};
    field("baseURL", "后端地址（不要包含 /api/v1）", stored.baseURL || "http://127.0.0.1:8080");
    field("token", "访问 Token（保存于油猴扩展存储）", stored.token, "password");
    field("platform", "平台标识（采集页与填写页保持一致）", site.platform || `超星MOOC@${origin}`);
    field("courseName", "课程名称", courseOverride.name || detected.courseName);
    field("externalID", "平台课程 ID", courseOverride.externalID || detected.externalID);
    field("username", "贡献用户名（优先自动识别，可手动修改）", site.username || detected.username);
    field("interval", "题目间隔（毫秒，0–5000）", stored.interval ?? 400, "number");
    inputs.interval.min = "0"; inputs.interval.max = "5000";
    const overwriteLabel = el("label", undefined, "check");
    const overwrite = el("input"); overwrite.type = "checkbox"; overwrite.checked = Boolean(stored.overwrite);
    overwriteLabel.append(overwrite, doc.createTextNode("允许改写已有选择（默认保留）")); fields.append(overwriteLabel);
    const advanced = el("details"); advanced.append(el("summary", "高级：私有平台选择器 JSON"));
    const selectorInput = el("textarea"); selectorInput.rows = 5; selectorInput.spellcheck = false; selectorInput.value = JSON.stringify(stored.selectors || {}, null, 2);
    advanced.append(selectorInput, el("p", "可覆盖 roots、stem、options、optionText、correctAnswer、courseName、username。", "hint")); fields.append(advanced);
    const save = el("button", "保存设置"); save.type = "button";
    fields.append(save, el("p", "课程名/ID 未识别时请补全。换后端主机后还需修改脚本头的 @connect。", "hint"));
    settings.append(fields);
    settings.open = !stored.token || !inputs.courseName.value || !inputs.externalID.value;
    const actions = el("div", undefined, "actions");
    const buttons = {};
    for (const [key, label] of [["scan", "扫描 / 预览"], ["upload", "上传采集"], ["lookup", "查询答案"], ["fill", "查询并填写"]]) {
      const button = el("button", label, key === "fill" ? "primary" : ""); button.type = "button";
      actions.append(button); buttons[key] = button;
    }
    const utility = el("div", undefined, "utility");
    const stop = el("button", "停止", "stop"); stop.type = "button"; stop.disabled = true;
    const diagnostics = el("button", "复制诊断"); diagnostics.type = "button";
    const openBank = el("a", "打开题库页面"); openBank.target = "_blank"; openBank.rel = "noopener noreferrer";
    try { openBank.href = connection(inputs.baseURL.value, stored.token || "unset").baseURL; } catch { openBank.href = "http://127.0.0.1:8080/"; }
    utility.append(stop, diagnostics, openBank);
    const list = el("div", undefined, "list");
    const logDetails = el("details"); logDetails.append(el("summary", "操作日志"));
    const logs = el("pre", "", "logs"); logDetails.append(logs);
    body.append(status, settings, actions, utility, list, logDetails, el("p", "仅处理当前已加载的单选/多选。答案冲突会跳过；不操作交卷或页面导航。", "foot"));
    panel.append(header, body); shadow.append(style, panel);

    function log(component, message, level = "info") {
      const line = `[${new Date().toLocaleTimeString()}][${component}][${level}] ${message}`;
      logs.textContent = `${logs.textContent}${line}\n`.split("\n").slice(-100).join("\n");
      console[level === "error" ? "error" : "info"](`[题库][${component}][${level}] ${message}`);
    }
    function message(value, level = "") { status.textContent = value; status.className = `status ${level}`; }
    function mark(question, value, level = "") {
      const node = resultRows.get(question);
      if (node) { node.textContent = value; node.className = level; }
    }
    function busyState(value) {
      busy = value; stop.disabled = !value; save.disabled = value;
      for (const button of Object.values(buttons)) button.disabled = value;
      diagnostics.disabled = value;
    }
    function readSettings() {
      const config = connection(inputs.baseURL.value.trim(), inputs.token.value.trim());
      const interval = Number(inputs.interval.value);
      if (!Number.isInteger(interval) || interval < 0 || interval > 5000) fail("题目间隔必须是 0–5000 的整数");
      return { ...config, interval, overwrite: overwrite.checked, selectors: validateSelectors(selectorInput.value, doc) };
    }
    function metadata(needsUsername) {
      const value = { platform: normalize(inputs.platform.value), external_id: normalize(inputs.externalID.value), name: normalize(inputs.courseName.value), username: normalize(inputs.username.value) };
      if (!value.platform || !value.name || !value.external_id) fail("请先补全平台标识、课程名称和平台课程 ID");
      if (needsUsername && !value.username) fail("请先填写贡献用户名");
      if ([...value.platform].length > 100 || [...value.external_id].length > 200 || [...value.name].length > 300 || [...value.username].length > 100) fail("课程或用户名字段超过后端长度限制");
      return value;
    }
    for (const key of ["courseName", "externalID", "username"]) {
      const hasOverride = key === "username" ? site.username : courseOverride[key === "courseName" ? "name" : "externalID"];
      if (hasOverride) inputs[key].dataset.dirty = "true";
      inputs[key].addEventListener("input", () => { inputs[key].dataset.dirty = "true"; });
    }
    function refresh() {
      const custom = validateSelectors(selectorInput.value, doc);
      snapshot = scan(doc, custom);
      const context = snapshot.questions[0]?.context || detectContext(doc, documents(doc).found, custom);
      for (const [key, value] of [["courseName", context.courseName], ["externalID", context.externalID], ["username", context.username]]) {
        if (value && !inputs[key].dataset.dirty) inputs[key].value = value;
      }
      list.replaceChildren(); resultRows.clear();
      snapshot.questions.forEach((question, index) => {
        const row = el("div", undefined, "question");
        row.append(el("strong", `${index + 1}. [${question.type === "single" ? "单选" : "多选"}] ${question.stem}`));
        row.append(el("p", question.options.map((option) => `${option.key}. ${option.text}`).join(" / "), "preview"));
        const result = el("p", question.correct_answers.length ? `页面可见正确答案：${question.correct_answers.join("、")}` : "已采集题目，未发现明确可见的正确答案", "preview");
        row.append(result); resultRows.set(question, result); list.append(row);
      });
      for (const issue of snapshot.issues) log("适配", `${issue.index ? `第 ${issue.index} 个容器：` : ""}${issue.reason}`, "warn");
      const answered = snapshot.questions.filter((question) => question.correct_answers.length).length;
      message(`识别 ${snapshot.questions.length} 题 · 可见正确答案 ${answered} 题 · 提示 ${snapshot.issues.length} 项`);
      log("扫描", `已扫描 ${snapshot.documents} 个文档，识别 ${snapshot.questions.length} 道单选/多选题`);
      return snapshot.questions;
    }
    save.addEventListener("click", () => {
      try {
        const config = readSettings();
        const sites = { ...(stored.sites || {}), [origin]: { platform: normalize(inputs.platform.value), username: normalize(inputs.username.value) } };
        const courses = { ...(stored.courses || {}) };
        const autoID = snapshot.questions[0]?.context.externalID || detected.externalID;
        if (autoID) courses[`${origin}|${autoID}`] = { name: normalize(inputs.courseName.value), externalID: normalize(inputs.externalID.value) };
        const value = { ...config, sites, courses };
        GM_setValue(STORAGE_KEY, value); Object.assign(stored, value);
        openBank.href = config.baseURL; message("设置已保存。可先扫描预览，再上传或查询。", "success");
        log("配置", "设置已保存（Token 不写入日志）");
      } catch (error) { message(error.message, "error"); }
    });
    buttons.scan.addEventListener("click", () => { try { refresh(); } catch (error) { message(error.message, "error"); } });
    collapse.addEventListener("click", () => {
      body.hidden = !body.hidden; body.classList.toggle("collapsed", body.hidden);
      collapse.textContent = body.hidden ? "展开" : "收起"; collapse.setAttribute("aria-expanded", String(!body.hidden));
    });
    stop.addEventListener("click", () => { controller?.abort(); message("已请求停止，正在结束当前题目操作。", "warn"); });
    diagnostics.addEventListener("click", () => {
      try {
        const report = { version: VERSION, url: sourceURL(doc.URL), documents: snapshot.documents, issues: snapshot.issues, selectors: validateSelectors(selectorInput.value, doc), detectedCourseID: detected.externalID, questionCount: snapshot.questions.length, examples: snapshot.questions.slice(0, 3).map((question) => ({ ...payload(question), source_url: question.source_url })) };
        GM_setClipboard(JSON.stringify(report, null, 2), "text");
        message("诊断信息已复制，包含前 3 题样本，不包含 Token 和用户名。", "success");
      } catch { message("复制诊断失败，请先检查选择器配置。", "error"); }
    });

    async function run(action) {
      if (busy) return;
      try {
        const config = readSettings();
        const questions = refresh();
        const meta = metadata(action === "upload");
        if (!questions.length) fail("未识别到题目，请等待页面加载或调整高级选择器");
        const ids = new Set(questions.map((question) => question.context.externalID).filter(Boolean));
        if (ids.size > 1) fail("同一页面识别到不同课程的题目，请进入单独的作业/测验页面操作");
        busyState(true); controller = new AbortController();
        const signal = controller.signal;
        const api = (method, path, data) => request(GM_xmlhttpRequest, config, method, path, data, signal);
        const registered = await api("POST", "/courses", { platform: meta.platform, external_id: meta.external_id, name: meta.name });
        const courseID = registered.data?.id;
        if (!courseID) fail("后端未返回课程 ID");
        if (action === "upload") {
          let received = 0, newQuestions = 0, newContributions = 0;
          for (const batch of batches(questions, courseID, meta.username)) {
            const result = await api("POST", "/questions/batch", batch);
            received += result.received; newQuestions += result.new_questions; newContributions += result.new_contributions;
            message(`已上传 ${received}/${questions.length} 题…`);
            log("上传", `本批 ${result.received} 题；新增题目 ${result.new_questions}，新增贡献 ${result.new_contributions}`);
          }
          questions.forEach((question) => mark(question, "已上传题目与页面可见正确答案（如有）", "success"));
          message(`上传完成：${received} 题，新增题目 ${newQuestions}，新增贡献 ${newContributions}。`, "success");
        } else {
          let matched = 0, filled = 0, skipped = 0;
          for (const [index, question] of questions.entries()) {
            if (signal.aborted) throw new DOMException("操作已停止", "AbortError");
            message(`${action === "fill" ? "查询并填写" : "查询"} ${index + 1}/${questions.length}…`);
            try {
              const query = payload(question); delete query.correct_answers;
              const result = await api("POST", "/questions/search", { course_id: courseID, ...query });
              const candidate = validatedCandidate(question, result); matched++;
              const names = [...new Set((candidate.contributors || []).map((user) => user.username))].join("、");
              const thanks = names ? ` · 感谢 ${names}` : "";
              if (signal.aborted) throw new DOMException("操作已停止", "AbortError");
              if (action === "fill") {
                const outcome = await fillQuestion(question, result, { overwrite: config.overwrite, custom: config.selectors });
                filled++;
                mark(question, `${outcome.status === "unchanged" ? "当前选择已一致" : "已填写并校验"}：${candidate.answer_keys.join("、")}${thanks}`, "success");
                log("填写", `第 ${index + 1} 题填写状态已校验`);
              } else mark(question, `题库答案：${candidate.answer_keys.join("、")}${thanks}`, "success");
            } catch (error) {
              if (error.status === 401 || error.name === "AbortError") throw error;
              skipped++; mark(question, error.message, "warn"); log("查询/填写", `第 ${index + 1} 题：${error.message}`, "warn");
            }
            if (index < questions.length - 1) await sleep(config.interval);
          }
          message(`完成：匹配 ${matched}/${questions.length} 题${action === "fill" ? `，填写/一致 ${filled} 题` : ""}，跳过 ${skipped} 题。`, "success");
        }
      } catch (error) {
        const stopped = error.name === "AbortError";
        const value = stopped ? "操作已停止；已完成的上传或填写保留。" : error.message;
        message(value, stopped ? "warn" : "error"); log("操作", value, stopped ? "warn" : "error");
        if (error.status === 401) settings.open = true;
      } finally { busyState(false); controller = null; }
    }
    for (const action of ["upload", "lookup", "fill"]) buttons[action].addEventListener("click", () => run(action));
    GM_registerMenuCommand("题库助手：显示 / 隐藏面板", () => { host.hidden = !host.hidden; });
    GM_registerMenuCommand("题库助手：重新扫描", () => { host.hidden = false; if (!busy) { try { refresh(); } catch (error) { message(error.message, "error"); } } });
    try { refresh(); } catch (error) { message(error.message, "error"); }
  }
})();
