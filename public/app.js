(function () {
  const toggleBtn = document.getElementById("sidebarToggle");
  const overlayHit = document.getElementById("overlayHit"); // zone cliquable à droite
  const links = document.querySelectorAll("#vnav a");

  const openDrawer = () =>
    document.documentElement.classList.add("drawer-open");
  const closeDrawer = () =>
    document.documentElement.classList.remove("drawer-open");

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      document.documentElement.classList.contains("drawer-open")
        ? closeDrawer()
        : openDrawer();
    });
  }

  overlayHit && overlayHit.addEventListener("click", closeDrawer);
  links.forEach((a) => a.addEventListener("click", closeDrawer));
})();
