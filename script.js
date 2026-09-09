// Bee Colony / Honey Farm — decorative-only interactions for the static mockup.
// No game logic/state here: everything is purely visual polish.

document.addEventListener('DOMContentLoaded', () => {
  // Bottom nav: swap the "active" tab highlight on click (visual only).
  const navButtons = document.querySelectorAll('.nav-btn');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      navButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Sell Honey: brief button feedback. Game state is handled in game-algorithm.js.
  const collectBtn = document.querySelector('.collect-btn');
  const jarGlass = document.querySelector('.jar-glass');
  if (collectBtn && jarGlass) {
    collectBtn.addEventListener('click', () => {
      jarGlass.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(.94)' },
        { transform: 'scale(1)' },
      ], { duration: 220, easing: 'ease-out' });
    });
  }

  // Honeycomb cells: light "tap" feedback (no state change).
  document.querySelectorAll('.hex').forEach((hex) => {
    hex.addEventListener('click', () => {
      hex.style.transform = 'scale(0.9)';
      setTimeout(() => { hex.style.transform = ''; }, 150);
    });
  });
});
