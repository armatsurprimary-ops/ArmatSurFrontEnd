/* User-provided page flip, loaded once from the app and decoded locally. */
window.App = window.App || {};
App.sound = (function () {
  let context, buffer, active, loading;
  function enabled() { return App.store.get().settings.playerTurnSound !== false; }

  function prepare() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return Promise.resolve(false);
      if (!context) context = new AudioContext();
      // Resume synchronously inside the user's gesture, before any async work.
      const resumed = (context.state === 'running' ? Promise.resolve() : context.resume())
        .then(function () { return true; }, function () { return false; });
      if (!buffer && !loading) {
        loading = fetch('assets/audio/page-turn.mp3').then(function (response) {
          if (!response.ok) throw new Error('Page-turn audio unavailable');
          return response.arrayBuffer();
        }).then(function (bytes) {
          return context.decodeAudioData(bytes);
        }).then(function (decoded) {
          buffer = decoded;
          return true;
        }, function () { return false; }).finally(function () { loading = null; });
      }
      return Promise.all([resumed, buffer ? true : loading]).then(function (ready) {
        return ready[0] && ready[1] && context.state === 'running';
      });
    } catch (e) { return Promise.resolve(false); }
  }

  function play(preview) {
    if (!preview && !enabled()) return false;
    // Never queue a stale notification until the user next clicks the page.
    if (!context || context.state !== 'running' || !buffer) return false;
    try {
      if (active) active.stop();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = function () {
        source.disconnect();
        if (active === source) active = null;
      };
      active = source;
      source.start();
      return true;
    } catch (e) { active = null; return false; }
  }

  // Unlock audio on ordinary interaction so a later, background handoff can play.
  function unlock(event) {
    if (event.isTrusted && enabled()) prepare();
  }
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock);
  return {
    playerTurn: function () { return play(false); },
    preview: function () { return prepare().then(function (ready) { return ready && play(true); }); }
  };
})();
