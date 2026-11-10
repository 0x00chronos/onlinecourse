"use strict";

(() => {
  const SESSION_KEY = "course-bank-token";
  const COURSE_SIZE = 10;
  const QUESTION_SIZE = 20;
  const $ = (id) => document.getElementById(id);
  const state = {
    token: "", selected: null, courses: [], coursePage: 1, courseTotal: 0,
    questionPage: 1, questionTotal: 0, courseQuery: "", questionQuery: "", type: "",
    courseRequest: null, questionRequest: null, courseSequence: 0, questionSequence: 0,
    coursesLoading: false, questionsLoading: false,
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sessionToken(value) {
    try {
      if (value === undefined) return sessionStorage.getItem(SESSION_KEY) || "";
      if (value) sessionStorage.setItem(SESSION_KEY, value);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Private browsing/storage restrictions should not prevent in-memory login.
    }
    return "";
  }

  function alertMessage(id, message = "") {
    $(id).textContent = message;
    $(id).hidden = !message;
  }

  function errorMessage(error) {
    if (error.name === "TypeError") return "连接失败，请确认服务正常运行后重试。";
    return error.message || "读取失败，请稍后重试。";
  }

  function lock(message = "") {
    state.courseSequence++;
    state.questionSequence++;
    state.courseRequest?.abort();
    state.questionRequest?.abort();
    state.coursesLoading = false;
    state.questionsLoading = false;
    state.token = "";
    state.selected = null;
    state.courses = [];
    sessionToken("");
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("logout").hidden = true;
    $("connection-label").classList.remove("connected");
    $("connection-text").textContent = "等待认证";
    $("course-list").replaceChildren();
    $("question-list").replaceChildren();
    $("token").value = "";
    $("token").type = "password";
    $("toggle-token").textContent = "显示";
    $("toggle-token").setAttribute("aria-pressed", "false");
    $("toggle-token").setAttribute("aria-label", "显示 Token");
    alertMessage("app-error");
    alertMessage("login-error", message);
    $("token").focus();
  }

  async function api(path, signal) {
    const token = state.token;
    const response = await fetch(`/api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "omit", cache: "no-store", signal,
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error("服务返回了无法识别的内容，请稍后重试。"); }
    if (response.status === 401) {
      if (token === state.token) lock("Token 无效或已被更换，请重新输入。");
      const error = new Error("Token 无效，请重新认证。");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const requestID = result.error?.request_id;
      const error = new Error(`${result.error?.message || "请求失败"}${requestID ? `（请求编号：${requestID}）` : ""}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function pages(total, size) { return Math.max(1, Math.ceil(total / size)); }

  function updateCoursePagination() {
    const last = pages(state.courseTotal, COURSE_SIZE);
    $("courses-page").textContent = `${state.coursePage} / ${last}`;
    $("courses-prev").disabled = state.coursesLoading || state.coursePage <= 1;
    $("courses-next").disabled = state.coursesLoading || state.coursePage >= last;
  }

  function updateQuestionPagination() {
    const last = pages(state.questionTotal, QUESTION_SIZE);
    $("questions-pagination").hidden = state.questionTotal === 0 || state.questionsLoading;
    $("questions-page").textContent = `${state.questionPage} / ${last}`;
    $("questions-prev").disabled = state.questionsLoading || state.questionPage <= 1;
    $("questions-next").disabled = state.questionsLoading || state.questionPage >= last;
    const from = (state.questionPage - 1) * QUESTION_SIZE + 1;
    const to = Math.min(state.questionPage * QUESTION_SIZE, state.questionTotal);
    $("questions-range").textContent = `显示第 ${from}–${to} 题，共 ${state.questionTotal} 题`;
  }

  function emptyState(title, description) {
    const node = element("div", "empty-state");
    node.append(element("span", "empty-symbol", "册"), element("h3", "", title), element("p", "", description));
    return node;
  }

  function renderCourses() {
    const list = $("course-list");
    list.replaceChildren();
    $("course-count").textContent = String(state.courseTotal);
    $("course-status").textContent = state.courseQuery ? `找到 ${state.courseTotal} 门相关课程` : `共 ${state.courseTotal} 门课程`;
    if (state.courses.length === 0) {
      list.append(element("p", "sidebar-caption", state.courseQuery ? "没有匹配的课程，请调整关键字。" : "尚未收录课程，等待脚本上传。"));
    }
    for (const course of state.courses) {
      const selected = state.selected?.id === course.id;
      const button = element("button", `course-item${selected ? " active" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected));
      const copy = element("span", "course-item-copy");
      copy.append(element("span", "course-item-name", course.name), element("span", "course-item-meta", course.platform));
      button.append(element("span", "course-symbol", "课"), copy);
      button.addEventListener("click", () => selectCourse(course));
      list.append(button);
    }
    updateCoursePagination();
  }

  function resetQuestions() {
    state.questionSequence++;
    state.questionRequest?.abort();
    state.questionsLoading = false;
    state.questionTotal = 0;
    $("question-total").textContent = "0";
    $("question-status").textContent = "";
    $("question-list").replaceChildren(emptyState("还没有课程", "课程收录后，即可在这里查看题目与参考答案。"));
    $("course-title").textContent = "选择一门课程";
    $("breadcrumb-course").textContent = "选择课程";
    $("course-meta").textContent = "从左侧选择课程，查阅题库与参考答案。";
    updateQuestionPagination();
  }

  async function loadCourses() {
    state.courseRequest?.abort();
    const controller = new AbortController();
    state.courseRequest = controller;
    const sequence = ++state.courseSequence;
    state.coursesLoading = true;
    $("course-list").setAttribute("aria-busy", "true");
    $("course-status").textContent = "正在读取课程…";
    alertMessage("app-error");
    updateCoursePagination();
    try {
      const params = new URLSearchParams({ page: state.coursePage, page_size: COURSE_SIZE });
      if (state.courseQuery) params.set("q", state.courseQuery);
      const result = await api(`/courses?${params}`, controller.signal);
      if (sequence !== state.courseSequence) return;
      state.courses = result.data;
      state.courseTotal = result.total;
      const selected = result.data.find((course) => course.id === state.selected?.id) || result.data[0];
      if (selected) {
        if (state.selected?.id === selected.id) {
          state.selected = selected;
          updateCourseHeading(selected);
          renderCourses();
          loadQuestions();
        } else selectCourse(selected);
      } else {
        state.selected = null;
        renderCourses();
        resetQuestions();
      }
    } catch (error) {
      if (error.name !== "AbortError" && error.status !== 401 && sequence === state.courseSequence) {
        alertMessage("app-error", errorMessage(error));
        $("course-status").textContent = "课程读取失败，点击刷新重试。";
      }
    } finally {
      if (sequence === state.courseSequence) {
        state.coursesLoading = false;
        $("course-list").setAttribute("aria-busy", "false");
        updateCoursePagination();
      }
    }
  }

  function selectCourse(course) {
    state.selected = course;
    state.questionPage = 1;
    state.questionTotal = 0;
    state.questionQuery = "";
    state.type = "";
    $("question-search").value = "";
    $("question-type").value = "";
    updateCourseHeading(course);
    renderCourses();
    loadQuestions();
  }

  function updateCourseHeading(course) {
    $("course-title").textContent = course.name;
    $("breadcrumb-course").textContent = course.name;
    $("course-meta").textContent = `${course.platform} · ${course.external_id ? `课程编号 ${course.external_id}` : `档案编号 ${course.id}`}`;
  }

  // Treat all uploaded text as text; only explicit http(s) URLs become links.
  function sourceLink(contribution) {
    let url;
    try { url = new URL(contribution.source_url); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const link = element("a", "", url.hostname);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `查看 ${contribution.username} 的答案来源：${url.hostname}`);
    return link;
  }

  function attributions(contributors) {
    const line = element("p", "attribution");
    const names = [...new Set(contributors.map((c) => c.username))];
    line.append(document.createTextNode("感谢 "));
    names.forEach((name, index) => {
      if (index) line.append(document.createTextNode("、"));
      line.append(element("span", "thanks-name", name));
    });
    line.append(document.createTextNode(" 提供答案"));
    const seen = new Set();
    for (const contributor of contributors) {
      if (seen.has(contributor.source_url)) continue;
      seen.add(contributor.source_url);
      const link = sourceLink(contributor);
      if (link) line.append(document.createTextNode(" · "), link);
    }
    return line;
  }

  function renderQuestion(question, index) {
    const card = element("article", `question-card${question.conflict ? " is-conflict" : ""}`);
    const top = element("div", "question-card-top");
    const labels = element("div", "question-card-labels");
    labels.append(element("span", "question-index", String((state.questionPage - 1) * QUESTION_SIZE + index + 1).padStart(2, "0")));
    labels.append(element("span", `badge ${question.type === "multiple" ? "badge-multiple" : "badge-type"}`, question.type === "multiple" ? "多选题" : "单选题"));
    labels.append(element("span", `badge ${question.conflict ? "badge-conflict" : question.has_answer ? "badge-answer" : "badge-unknown"}`, question.conflict ? "答案有分歧" : question.has_answer ? "有参考答案" : "暂无答案"));
    top.append(labels, element("span", "question-id", `#${question.id}`));
    card.append(top, element("h3", "", question.stem));
    const answerKeys = new Set(!question.conflict && question.has_answer ? question.answer_candidates[0].answer_keys : []);
    const options = element("ul", "options");
    for (const option of question.options) {
      const item = element("li", `option${answerKeys.has(option.key) ? " is-answer" : ""}`);
      item.append(element("span", "option-key", option.key), element("span", "option-text", option.text));
      options.append(item);
    }
    card.append(options);
    const section = element("div", "answer-section");
    if (question.conflict) section.append(element("p", "conflict-note", "这道题存在不同答案，请结合来源自行核对。"));
    if (!question.has_answer) section.append(element("p", "no-answer", "暂无参考答案，等待后续贡献补充。"));
    question.answer_candidates.forEach((candidate, candidateIndex) => {
      const group = element("div", "answer-group");
      const heading = element("div", "answer-heading");
      const values = element("div", "answer-values");
      candidate.answer_keys.forEach((key, i) => values.append(element("span", "answer-pill", `${key} · ${candidate.answer_texts[i]}`)));
      heading.append(element("span", "answer-title", question.conflict ? `候选 ${candidateIndex + 1}` : "参考答案"), values);
      group.append(heading, attributions(candidate.contributors));
      group.append(element("p", "attribution", `${candidate.support_count} 位用户提供 · 尚未经人工审核`));
      section.append(group);
    });
    card.append(section);
    if (question.contributors.length) {
      const details = element("details", "sources");
      details.append(element("summary", "", `查看来源与贡献记录（${question.contributors.length}）`));
      const list = element("ul", "source-list");
      for (const contributor of question.contributors) {
        const item = element("li");
        const info = element("span", "", `${contributor.username} · `);
        info.append(sourceLink(contributor) || document.createTextNode("来源记录"));
        const date = new Date(contributor.submitted_at);
        item.append(info);
        if (!Number.isNaN(date.getTime())) {
          const time = element("time", "", date.toLocaleDateString("zh-CN"));
          time.dateTime = date.toISOString();
          item.append(time);
        }
        list.append(item);
      }
      details.append(list);
      card.append(details);
    }
    return card;
  }

  async function loadQuestions() {
    if (!state.selected || !state.token) return;
    state.questionRequest?.abort();
    const controller = new AbortController();
    state.questionRequest = controller;
    const sequence = ++state.questionSequence;
    state.questionsLoading = true;
    alertMessage("app-error");
    $("question-list").setAttribute("aria-busy", "true");
    $("question-list").replaceChildren(element("div", "loading-state", "正在查阅课程题库…"));
    $("question-status").textContent = "正在读取题目…";
    $("question-total").textContent = "—";
    updateQuestionPagination();
    try {
      const params = new URLSearchParams({ course_id: state.selected.id, page: state.questionPage, page_size: QUESTION_SIZE });
      if (state.questionQuery) params.set("q", state.questionQuery);
      if (state.type) params.set("type", state.type);
      const result = await api(`/questions?${params}`, controller.signal);
      if (sequence !== state.questionSequence) return;
      state.questionTotal = result.total;
      $("question-total").textContent = String(result.total);
      $("question-status").textContent = state.questionQuery || state.type ? `找到 ${result.total} 道符合条件的题目` : `已收录 ${result.total} 道题目，按最新收录排序`;
      const list = $("question-list");
      list.replaceChildren();
      if (result.data.length === 0) {
        list.append(emptyState(state.questionQuery || state.type ? "没有找到相关题目" : "题库等待收录", state.questionQuery || state.type ? "试试其他关键字，或切换为全部题型。" : "这门课程还没有题目，脚本上传后即可在这里查看。"));
      } else result.data.forEach((question, index) => list.append(renderQuestion(question, index)));
    } catch (error) {
      if (error.name !== "AbortError" && error.status !== 401 && sequence === state.questionSequence) {
        state.questionTotal = 0;
        alertMessage("app-error", errorMessage(error));
        $("question-list").replaceChildren(emptyState("题目读取失败", "点击右上角刷新，重新连接题库。"));
        $("question-status").textContent = "读取失败";
        $("question-total").textContent = "—";
      }
    } finally {
      if (sequence === state.questionSequence) {
        state.questionsLoading = false;
        $("question-list").setAttribute("aria-busy", "false");
        updateQuestionPagination();
      }
    }
  }

  async function connect(token) {
    $("login-submit").disabled = true;
    $("login-submit").textContent = "正在认证…";
    alertMessage("login-error");
    state.token = token;
    try {
      // A protected data request verifies the Token before revealing the workspace.
      await api("/courses?page=1&page_size=1");
      sessionToken(token);
      $("token").value = "";
      $("login-view").hidden = true;
      $("app-view").hidden = false;
      $("logout").hidden = false;
      $("connection-label").classList.add("connected");
      $("connection-text").textContent = "已认证";
      state.coursePage = 1;
      state.courseQuery = "";
      $("course-search").value = "";
      $("course-search").focus();
      await loadCourses();
    } catch (error) {
      if (error.status !== 401) lock(errorMessage(error));
    } finally {
      $("login-submit").disabled = false;
      $("login-submit").replaceChildren(document.createTextNode("进入题库 "), element("span", "", "→"));
    }
  }

  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const token = $("token").value.trim();
    if (token) connect(token);
  });
  $("toggle-token").addEventListener("click", () => {
    const visible = $("token").type === "password";
    $("token").type = visible ? "text" : "password";
    $("toggle-token").textContent = visible ? "隐藏" : "显示";
    $("toggle-token").setAttribute("aria-label", visible ? "隐藏 Token" : "显示 Token");
    $("toggle-token").setAttribute("aria-pressed", String(visible));
  });
  $("logout").addEventListener("click", () => lock());
  $("course-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.courseQuery = $("course-search").value.trim();
    state.coursePage = 1;
    loadCourses();
  });
  $("question-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.questionQuery = $("question-search").value.trim();
    state.type = $("question-type").value;
    state.questionPage = 1;
    loadQuestions();
  });
  $("question-type").addEventListener("change", () => $("question-search-form").requestSubmit());
  $("courses-prev").addEventListener("click", () => { state.coursePage--; loadCourses(); });
  $("courses-next").addEventListener("click", () => { state.coursePage++; loadCourses(); });
  $("questions-prev").addEventListener("click", () => { state.questionPage--; loadQuestions(); });
  $("questions-next").addEventListener("click", () => { state.questionPage++; loadQuestions(); });
  $("refresh").addEventListener("click", () => {
    loadCourses();
  });

  const saved = sessionToken();
  if (saved) connect(saved);
})();
