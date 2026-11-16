/* Runs before the stylesheet so saved appearance is applied before first paint.
 * This is a global preference; it never changes a session or an active draft. */
window.App = window.App || {};
App.theme = (function () {
  function apply(value) {
    const mode = value === 'night' ? 'night' : 'day';
    document.documentElement.dataset.theme = mode;
    ['day', 'night'].forEach(function (name) {
      const button = document.getElementById(name === 'day' ? 'themeDay' : 'themeNight');
      if (button) button.setAttribute('aria-pressed', String(name === mode));
    });
  }
  function set(mode) {
    App.store.get().settings.theme = mode === 'night' ? 'night' : 'day';
    App.store.save();
    apply(mode);
  }
  let saved;
  try { saved = JSON.parse(localStorage.getItem('armatsur-settings-v1') || 'null'); }
  catch (e) { /* Appearance must work even if browser storage is unavailable. */ }
  apply(saved && saved.settings && saved.settings.theme);
  return { apply: apply, set: set };
})();
