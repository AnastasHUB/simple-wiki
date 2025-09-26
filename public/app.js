(function(){
  const toggleBtn = document.getElementById('sidebarToggle');
  const overlay = document.getElementById('drawerOverlay');
  const links = document.querySelectorAll('#vnav a');

  function openDrawer(){ document.documentElement.classList.add('drawer-open'); }
  function closeDrawer(){ document.documentElement.classList.remove('drawer-open'); }

  if (toggleBtn){
    toggleBtn.addEventListener('click', function(e){
      e.preventDefault();
      if (document.documentElement.classList.contains('drawer-open')) closeDrawer();
      else openDrawer();
    });
  }
  overlay && overlay.addEventListener('click', closeDrawer);
  links.forEach(a => a.addEventListener('click', closeDrawer));
})();
