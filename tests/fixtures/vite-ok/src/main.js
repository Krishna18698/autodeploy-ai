document.querySelector('#app').textContent =
  'Hello from ' + (import.meta.env.VITE_GREETING ?? 'AutoDeploy');
