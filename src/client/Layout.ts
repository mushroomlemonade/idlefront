function navigationElements() {
  return {
    backdrop: document.getElementById("mobile-menu-backdrop"),
    controls: [
      document.getElementById("hamburger-btn"),
      document.getElementById("desktop-menu-button"),
    ].filter((element): element is HTMLElement => element !== null),
    sidebar: document.getElementById("sidebar-menu"),
  };
}

export function setNavigationDrawer(open: boolean): void {
  const { backdrop, controls, sidebar } = navigationElements();
  if (!sidebar || !backdrop) return;

  sidebar.classList.toggle("open", open);
  backdrop.classList.toggle("open", open);
  document.documentElement.classList.toggle("overflow-hidden", open);
  sidebar.setAttribute("aria-hidden", open ? "false" : "true");
  backdrop.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) sidebar.setAttribute("aria-modal", "true");
  else sidebar.removeAttribute("aria-modal");
  controls.forEach((control) =>
    control.setAttribute("aria-expanded", open ? "true" : "false"),
  );
}

export function toggleNavigationDrawer(event?: Event): void {
  event?.stopPropagation();
  if (event?.type === "touchstart") event.preventDefault();
  const sidebar = document.getElementById("sidebar-menu");
  setNavigationDrawer(!sidebar?.classList.contains("open"));
}

export function initLayout() {
  Promise.all([
    customElements.whenDefined("play-page"),
    customElements.whenDefined("desktop-nav-bar"),
    customElements.whenDefined("mobile-nav-bar"),
  ]).then(() => {
    const { backdrop, controls, sidebar } = navigationElements();
    if (!sidebar || !backdrop || controls.length === 0) {
      console.error("Navigation drawer controls not found");
      return;
    }
    if (sidebar.dataset.navigationReady === "true") return;
    sidebar.dataset.navigationReady = "true";
    sidebar.style.display = "flex";

    controls.forEach((control) => {
      control.onclick = null;
      control.addEventListener("click", toggleNavigationDrawer);
    });
    backdrop.addEventListener("click", () => setNavigationDrawer(false));
    sidebar.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest("a, button, atlas-nav-item, .nav-menu-item")) {
        setNavigationDrawer(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && sidebar.classList.contains("open")) {
        setNavigationDrawer(false);
      }
    });
    setNavigationDrawer(false);
  });
}
