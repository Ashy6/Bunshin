const root = document.documentElement;
const savedTheme = localStorage.getItem("bunshin-theme");
if (savedTheme) root.dataset.theme = savedTheme;
document.querySelector("#theme-toggle")?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("bunshin-theme", next);
});
const sidebar = document.querySelector(".sidebar");
document.querySelector("#menu-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  sidebar?.classList.toggle("open");
});
document.querySelector(".page")?.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 980px)").matches)
    sidebar?.classList.remove("open");
});
sidebar?.querySelectorAll("nav a").forEach((link) =>
  link.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 980px)").matches)
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
    let buffer = "";
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
        if (data.type === "delta") answer.textContent += data.text;
        if (data.type === "error") answer.textContent += `\n${data.text}`;
        if (data.type === "sources" && sources) {
          sources.hidden = false;
          const title = document.createElement("strong");
          title.textContent = "参考资料";
          sources.append(title);
          const list = document.createElement("ul");
          for (const item of data.items) {
            const entry = document.createElement("li");
            entry.textContent = item.title;
            list.append(entry);
          }
          sources.append(list);
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
