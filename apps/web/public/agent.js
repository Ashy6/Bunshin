const root = document.documentElement;
const savedTheme = localStorage.getItem("bunshin-theme");
if (savedTheme) root.dataset.theme = savedTheme;
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-theme-toggle]")) return;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("bunshin-theme", next);
});
const sidebar = document.querySelector(".sidebar");
document.querySelector("#menu-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  sidebar?.classList.toggle("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") sidebar?.classList.remove("open");
});
document.querySelector(".page")?.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 767px)").matches)
    sidebar?.classList.remove("open");
});
sidebar?.querySelectorAll("nav a").forEach((link) =>
  link.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 767px)").matches)
      sidebar.classList.remove("open");
  }),
);
const input = document.querySelector("#ask-input");
const form = document.querySelector("#ask-form");
const submitButton = form?.querySelector("button[type='submit']");
const statusText = document.querySelector("#agent-status");
const quotaText = document.querySelector("#agent-quota");
const answer = document.querySelector("#answer");
const sources = document.querySelector("#answer-sources");
let agentReady = false;
let remainingCount = 0;
let sending = false;
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d+)\]/g, '<sup class="citation">[$1]</sup>');
}
function renderAnswer(value) {
  const lines = value.replace(/\r/g, "").split("\n"), blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || "";
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) items.push(`<li>${inline(lines[index++].replace(/^[-*]\s+/, ""))}</li>`);
      blocks.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) items.push(`<li>${inline(lines[index++].replace(/^\d+[.)]\s+/, ""))}</li>`);
      blocks.push(`<ol>${items.join("")}</ol>`); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s|^[-*]\s+|^\d+[.)]\s+/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${inline(paragraph.join("\n")).replaceAll("\n", "<br>")}</p>`);
  }
  return blocks.join("");
}

function renderSources(container, items) {
  container.hidden = false;
  container.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "参考资料";
  container.append(title);
  const list = document.createElement("ul");
  for (const item of items) {
    const entry = document.createElement("li");
    entry.className = "source-row";
    const label = document.createElement("span");
    label.className = "source-title";
    label.textContent = `${item.index ? `[${item.index}] ` : ""}${item.title}`;
    entry.append(label);
    if (item.href) {
      const action = document.createElement("a");
      action.className = "source-action";
      action.href = item.href;
      action.textContent = "访问原文章 →";
      action.setAttribute("aria-label", `访问原文章：${item.title}`);
      entry.append(action);
    }
    list.append(entry);
  }
  container.append(list);
}

function setAvailability(status) {
  agentReady = Boolean(status.ready);
  remainingCount = Number(status.remaining || 0);
  if (statusText)
    statusText.textContent = status.ready
      ? "Agent 已就绪"
      : status.reason || "Agent 尚未就绪";
  if (quotaText)
    quotaText.textContent = `今日剩余 ${status.remaining}/${status.dailyLimit} 次`;
  if (submitButton)
    submitButton.disabled = !status.ready || status.remaining <= 0;
  if (input) {
    input.disabled = !status.ready || status.remaining <= 0;
    input.placeholder = status.ready
      ? "在这里问我，例如：你做过哪些代表项目？"
      : status.reason || "Agent 尚未就绪";
  }
}
fetch("/api/agent/status")
  .then((response) => response.json())
  .then(setAvailability)
  .catch(() => {
    if (statusText) statusText.textContent = "Agent 状态读取失败";
  });

document.querySelectorAll(".suggestions button").forEach((button) =>
  button.addEventListener("click", () => {
    if (!input || input.disabled) return;
    input.value = button.textContent;
    form?.requestSubmit();
  }),
);

input?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  form?.requestSubmit();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input?.value.trim();
  if (!message || !answer || sending || !agentReady || remainingCount <= 0)
    return;
  sending = true;
  answer.hidden = false;
  answer.textContent = "正在检索知识库…";
  if (sources) {
    sources.hidden = true;
    sources.innerHTML = "";
  }
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.ok || !response.body) {
      const result = await response.json().catch(() => ({}));
      answer.textContent = result.error || "暂时无法回答，请稍后再试。";
      return;
    }
    answer.textContent = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", answerText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const eventText of events) {
        const line = eventText
          .split("\n")
          .find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === "delta") {
          answerText += data.text;
          answer.innerHTML = renderAnswer(answerText);
        }
        if (data.type === "error") {
          answerText += `\n\n${data.text}`;
          answer.innerHTML = renderAnswer(answerText);
        }
        if (data.type === "sources" && sources) {
          renderSources(sources, data.items);
        }
        if (data.type === "done" && Number.isFinite(data.remaining)) {
          remainingCount = data.remaining;
          if (quotaText)
            quotaText.textContent = `今日剩余 ${remainingCount} 次`;
        }
      }
    }
  } catch {
    answer.textContent = "网络连接中断，请稍后重新提问。";
  } finally {
    sending = false;
    if (submitButton)
      submitButton.disabled = !agentReady || remainingCount <= 0;
  }
});

function navKey(pathname) {
  if (pathname === "/articles" || pathname.startsWith("/articles/")) return "articles";
  if (pathname.startsWith("/categories")) return "categories";
  if (pathname === "/archives") return "archives";
  if (pathname === "/about") return "about";
  return "ask";
}

function syncActiveNavigation(pathname) {
  const active = navKey(pathname);
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const selected = link.dataset.nav === active;
    link.classList.toggle("active", selected);
    link.classList.toggle("nav-link", !selected);
    if (selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function syncHead(nextDocument) {
  document.title = nextDocument.title;
  for (const selector of [
    'meta[name="description"]',
    'meta[name="author"]',
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:type"]',
    'meta[property="og:url"]',
  ]) {
    const current = document.head.querySelector(selector);
    const next = nextDocument.head.querySelector(selector);
    if (current && next) current.setAttribute("content", next.getAttribute("content") || "");
  }
  const currentCanonical = document.head.querySelector('link[rel="canonical"]');
  const nextCanonical = nextDocument.head.querySelector('link[rel="canonical"]');
  if (currentCanonical && nextCanonical)
    currentCanonical.setAttribute("href", nextCanonical.getAttribute("href") || location.href);
  const currentJsonLd = document.head.querySelector('script[type="application/ld+json"]');
  const nextJsonLd = nextDocument.head.querySelector('script[type="application/ld+json"]');
  if (currentJsonLd && nextJsonLd) currentJsonLd.textContent = nextJsonLd.textContent;
}

let navigationController = null;
async function navigateWithoutReload(url, push = true) {
  const destination = new URL(url, location.href);
  if (destination.origin !== location.origin) return;
  if (push && destination.pathname === location.pathname && destination.search === location.search) return;
  navigationController?.abort();
  navigationController = new AbortController();
  const page = document.querySelector(".page");
  page?.classList.add("is-loading");
  page?.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(destination.href, {
      signal: navigationController.signal,
      headers: { "X-Bunshin-Navigation": "partial" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const nextDocument = new DOMParser().parseFromString(await response.text(), "text/html");
    const currentMain = document.querySelector("main");
    const nextMain = nextDocument.querySelector("main");
    if (!currentMain || !nextMain) throw new Error("页面内容不完整");
    const apply = () => {
      currentMain.replaceWith(nextMain);
      const currentFooter = document.querySelector("footer");
      const nextFooter = nextDocument.querySelector("footer");
      if (currentFooter && nextFooter) currentFooter.replaceWith(nextFooter);
      const currentPageTitle = document.querySelector("#page-title");
      const nextPageTitle = nextDocument.querySelector("#page-title");
      if (currentPageTitle && nextPageTitle) currentPageTitle.replaceWith(nextPageTitle);
      syncHead(nextDocument);
      syncActiveNavigation(destination.pathname);
      if (push) history.pushState({ bunshin: true }, "", destination.href);
      window.scrollTo(0, 0);
      bindDynamicAgentPage();
    };
    if (document.startViewTransition) await document.startViewTransition(apply).finished;
    else apply();
  } catch (error) {
    if (error?.name !== "AbortError") location.assign(destination.href);
  } finally {
    page?.classList.remove("is-loading");
    page?.removeAttribute("aria-busy");
  }
}

function applyDynamicAvailability(status, dynamicForm) {
  agentReady = Boolean(status.ready);
  remainingCount = Number(status.remaining || 0);
  const dynamicInput = dynamicForm.querySelector("#ask-input");
  const dynamicSubmit = dynamicForm.querySelector("button[type='submit']");
  const dynamicStatus = document.querySelector("#agent-status");
  const dynamicQuota = document.querySelector("#agent-quota");
  if (dynamicStatus) dynamicStatus.textContent = status.ready ? "Agent 已就绪" : status.reason || "Agent 尚未就绪";
  if (dynamicQuota) dynamicQuota.textContent = `今日剩余 ${status.remaining}/${status.dailyLimit} 次`;
  if (dynamicSubmit) dynamicSubmit.disabled = !status.ready || status.remaining <= 0;
  if (dynamicInput) {
    dynamicInput.disabled = !status.ready || status.remaining <= 0;
    dynamicInput.placeholder = status.ready
      ? "在这里问我，例如：你做过哪些代表项目？"
      : status.reason || "Agent 尚未就绪";
  }
}

async function submitDynamicQuestion(dynamicForm) {
  const dynamicInput = dynamicForm.querySelector("#ask-input");
  const dynamicAnswer = document.querySelector("#answer");
  const dynamicSources = document.querySelector("#answer-sources");
  const dynamicSubmit = dynamicForm.querySelector("button[type='submit']");
  const message = dynamicInput?.value.trim();
  if (!message || !dynamicAnswer || sending || !agentReady || remainingCount <= 0) return;
  sending = true;
  dynamicAnswer.hidden = false;
  dynamicAnswer.textContent = "正在检索知识库…";
  if (dynamicSources) { dynamicSources.hidden = true; dynamicSources.replaceChildren(); }
  if (dynamicSubmit) dynamicSubmit.disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.ok || !response.body) {
      const result = await response.json().catch(() => ({}));
      dynamicAnswer.textContent = result.error || "暂时无法回答，请稍后再试。";
      return;
    }
    dynamicAnswer.textContent = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", answerText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const eventText of events) {
        const line = eventText.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === "delta") { answerText += data.text; dynamicAnswer.innerHTML = renderAnswer(answerText); }
        if (data.type === "error") { answerText += `\n\n${data.text}`; dynamicAnswer.innerHTML = renderAnswer(answerText); }
        if (data.type === "sources" && dynamicSources) renderSources(dynamicSources, data.items);
        if (data.type === "done" && Number.isFinite(data.remaining)) {
          remainingCount = data.remaining;
          const dynamicQuota = document.querySelector("#agent-quota");
          if (dynamicQuota) dynamicQuota.textContent = `今日剩余 ${remainingCount} 次`;
        }
      }
    }
  } catch {
    dynamicAnswer.textContent = "网络连接中断，请稍后重新提问。";
  } finally {
    sending = false;
    if (dynamicSubmit?.isConnected) dynamicSubmit.disabled = !agentReady || remainingCount <= 0;
  }
}

function bindDynamicAgentPage() {
  const dynamicForm = document.querySelector("#ask-form");
  if (!dynamicForm) return;
  agentReady = false;
  remainingCount = 0;
  sending = false;
  fetch("/api/agent/status")
    .then((response) => response.json())
    .then((status) => applyDynamicAvailability(status, dynamicForm))
    .catch(() => {
      const dynamicStatus = document.querySelector("#agent-status");
      if (dynamicStatus) dynamicStatus.textContent = "Agent 状态读取失败";
    });
  dynamicForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDynamicQuestion(dynamicForm);
  });
  const dynamicInput = dynamicForm.querySelector("#ask-input");
  dynamicInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    dynamicForm.requestSubmit();
  });
  document.querySelectorAll(".suggestions button").forEach((button) =>
    button.addEventListener("click", () => {
      if (!dynamicInput || dynamicInput.disabled) return;
      dynamicInput.value = button.textContent || "";
      dynamicForm.requestSubmit();
    }),
  );
}

document.addEventListener("click", (event) => {
  const anchor = event.target.closest("a[href]");
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.download || anchor.target === "_blank") return;
  const destination = new URL(anchor.href, location.href);
  if (destination.origin !== location.origin || destination.pathname.startsWith("/api/")) return;
  event.preventDefault();
  sidebar?.classList.remove("open");
  void navigateWithoutReload(destination.href);
});

window.addEventListener("popstate", () => void navigateWithoutReload(location.href, false));
history.scrollRestoration = "manual";
syncActiveNavigation(location.pathname);
