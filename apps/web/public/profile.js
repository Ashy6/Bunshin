fetch("/api/profile")
  .then((response) => (response.ok ? response.json() : null))
  .then((data) => {
    const profile = data?.profile;
    if (!profile) return;
    const name = document.querySelector("#profile-name");
    const headline = document.querySelector("#profile-headline");
    if (name && profile.display_name) name.textContent = profile.display_name;
    if (headline && profile.headline) headline.textContent = profile.headline;
    if (profile.display_name) {
      const siteTitle = `${profile.display_name}-AI分身`;
      const pageTitle = document.querySelector("#page-title");
      const greeting = document.querySelector("#agent-greeting");
      const pageLabel = pageTitle?.dataset.pageLabel || "";
      const fullTitle = pageLabel ? `${pageLabel} · ${siteTitle}` : siteTitle;
      if (pageTitle) pageTitle.textContent = fullTitle;
      if (greeting)
        greeting.textContent = `你好，我是${profile.display_name}的 AI 分身`;
      document.title = fullTitle;
    }
  })
  .catch(() => {});
