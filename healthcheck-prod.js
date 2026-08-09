const http = require('http');

function checkEndpoint({ port, path }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy) => {
      if (!settled) {
        settled = true;
        resolve(healthy);
      }
    };

    const req = http.get({
      hostname: 'localhost',
      port,
      path,
      timeout: 5000,
    }, (res) => {
      res.resume();
      finish(res.statusCode >= 200 && res.statusCode < 400);
    });

    req.on('error', () => finish(false));
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
  });
}

Promise.all([
  checkEndpoint({ port: 3030, path: '/' }),
  checkEndpoint({ port: 3006, path: '/health/ready' }),
]).then((results) => {
  process.exit(results.every(Boolean) ? 0 : 1);
});
