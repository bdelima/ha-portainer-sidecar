// An expired or removed session shows up as a 401 from /api/*. Reload, so the
// server sends the page to the sign-in form instead of the tabs filling with
// errors. Loaded before app.js so every fetch it makes goes through this.
(function () {
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await realFetch(...args);
    if (res.status === 401) window.location.reload();
    return res;
  };
})();
