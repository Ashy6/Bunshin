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
      const pageLabel = pageTitle?.dataset.pageLabel || "";
      const fullTitle = pageLabel ? `${pageLabel} · ${siteTitle}` : siteTitle;
      if (pageTitle) pageTitle.textContent = fullTitle;
      document.title = fullTitle;
    }
  })
  .catch(() => {});
