// Only loaded by the integration test. Keep every OAuth/Drive request on its test server.
const originalFetch = globalThis.fetch;
globalThis.fetch = (resource, options) => {
  const url = new URL(resource);
  if (['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com'].includes(url.hostname)) {
    return originalFetch(process.env.TEST_DRIVE_SERVER + url.pathname + url.search, options);
  }
  return originalFetch(resource, options);
};
