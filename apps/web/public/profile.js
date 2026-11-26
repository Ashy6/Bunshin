fetch("/api/profile")
  .then((response) => (response.ok ? response.json() : null))
  .then((data) => {
    const profile = data?.profile;
    if (!profile) return;
    const name = document.querySelector("#profile-name");
    const headline = document.querySelector("#profile-headline");
    if (name && profile.display_name) name.textContent = profile.display_name;
    if (headline && profile.headline) headline.textContent = profile.headline;
  })
  .catch(() => {});
