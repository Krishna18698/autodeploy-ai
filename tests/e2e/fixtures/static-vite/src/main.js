// The bundle carries the smoke suite's marker; the page shows the script ran.
const el = document.querySelector('#app');
el.textContent = '✓ running in your browser';
el.dataset.check = 'e2e static ok';
