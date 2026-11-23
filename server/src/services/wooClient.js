// WooCommerce REST API calls (wp-json/wc/v3), build-docs/features/woocommerce-integration.md.
// Basic auth over https with the store's consumer key/secret. Every request
// uses redirect: 'error' so a store URL that passed the public-address check
// (utils/publicUrl.js) can't redirect the server to an internal address.
const TIMEOUT_MS = 15_000;

async function wooFetch(storeUrl, path, { key, secret, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${storeUrl}/wp-json/wc/v3${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Wasi-WooCommerce-Integration',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'the store did not answer in time' : 'the store could not be reached';
    throw new Error(`WooCommerce request failed: ${reason}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('The store rejected the API keys. Check they are correct and have Read/Write permission.');
    if (res.status === 404) throw new Error('This does not look like a WooCommerce store (no WooCommerce REST API found at this address).');
    throw new Error(data?.message ? `WooCommerce: ${data.message}` : `WooCommerce returned an error (${res.status}).`);
  }
  return data;
}

// Cheap authenticated call that proves the keys work and can manage webhooks.
const verifyAccess = (store) => wooFetch(store.url, '/webhooks?per_page=1', store);

async function createWebhook(store, { topic, deliveryUrl, secret }) {
  const data = await wooFetch(store.url, '/webhooks', {
    ...store, method: 'POST',
    body: { name: `Wasi ${topic}`, topic, delivery_url: deliveryUrl, secret, status: 'active' },
  });
  return data.id;
}

const deleteWebhook = (store, id) => wooFetch(store.url, `/webhooks/${encodeURIComponent(id)}?force=true`, { ...store, method: 'DELETE' });

module.exports = { verifyAccess, createWebhook, deleteWebhook };
