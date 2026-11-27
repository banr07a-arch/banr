const pages = [
  ["patient", "./#patient", "Patient App"],
  ["provider", "./#provider", "Provider Portal"],
  ["staff", "./#staff", "Clinic Staff Access"],
  ["directory", "onboarding.html#directory", "Healthcare Directory"],
  ["support", "onboarding.html#support", "Support Requests"],
  ["audit", "onboarding.html#audit", "Audit Log"],
  ["requests", "onboarding.html#requests", "Provider Requests"],
  ["plans", "onboarding.html#plans", "Subscription Plans"],
  ["templates", "onboarding.html#templates", "Notification Templates"],
];
const layout = document.querySelector(".admin-shell");
const sidebar = document.querySelector(".admin-nav");
const heading = document.querySelector("#page-title");

export function currentSection(allowed, fallback) {
  const section = location.hash.slice(1);
  return allowed.includes(section) ? section : fallback;
}

export function showAdminSection(section) {
  layout.dataset.ready = "";
  heading.textContent = pages.find(page => page[0] === section)[2];
  sidebar.innerHTML = '<a class="admin-nav-brand" href="./">BANR Super Admin</a>' +
    '<nav aria-label="Super Admin features">' + pages.map(([key, href, name]) =>
      '<a href="' + href + '"' + (key === section ? ' aria-current="page"' : '') + '>' + name + '</a>'
    ).join("") + '</nav>';
}

export function hideAdminNavigation() {
  delete layout.dataset.ready;
  sidebar.replaceChildren();
  heading.textContent = "BANR Super Admin";
}
