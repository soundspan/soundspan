// soundspan Service Worker
const CACHE_NAME = 'soundspan-v1';
const IMAGE_CACHE_NAME = 'soundspan-images-v3';
const IMAGE_METADATA_CACHE_NAME = 'soundspan-images-metadata-v2';
const MAX_IMAGE_CACHE_ENTRIES = 2000;
const MAX_CONCURRENT_IMAGE_REQUESTS = 4;
const REQUEST_DELAY_MS = 10;
const IMAGE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Assets to cache on install (app shell)
const PRECACHE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/assets/images/soundspan.webp',
];

// Image route patterns to cache
const IMAGE_PATTERNS = [
  /^\/api\/library\/cover-art/,
  /^\/api\/audiobooks\/.*\/cover/,
  /^\/api\/podcasts\/.*\/cover/,
];

// Request queue for throttling concurrent image fetches
let activeImageRequests = 0;
const imageRequestQueue = [];

/**
 * Check if a URL should use image caching
 */
function isImageRoute(pathname) {
  return IMAGE_PATTERNS.some(pattern => pattern.test(pathname));
}

/**
 * Build a stable cache key for image requests by stripping the rotating
 * auth token query param (it rotates daily and would otherwise invalidate
 * the whole art cache every day). Size/format params stay in the key.
 * The original request (with token) is still used for the network fetch.
 */
function getImageCacheKey(request, url) {
  if (!url.searchParams.has('token')) {
    return request;
  }
  const keyUrl = new URL(url.toString());
  keyUrl.searchParams.delete('token');
  return new Request(keyUrl.toString(), { headers: request.headers });
}

/**
 * Trim cache to max entries (LRU eviction by oldest)
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const metadataCache = await caches.open(IMAGE_METADATA_CACHE_NAME);
  const keys = await cache.keys();

  if (keys.length > maxEntries) {
    // Delete oldest entries (first in = oldest)
    const deleteCount = keys.length - maxEntries;
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
      await metadataCache.delete(keys[i]);
    }
  }
}

async function setImageCachedAt(request) {
  const metadataCache = await caches.open(IMAGE_METADATA_CACHE_NAME);
  await metadataCache.put(request, new Response(String(Date.now())));
}

async function getImageCachedAt(request) {
  const metadataCache = await caches.open(IMAGE_METADATA_CACHE_NAME);
  const metadataResponse = await metadataCache.match(request);
  if (!metadataResponse) {
    return null;
  }

  const cachedAt = Number(await metadataResponse.text());
  if (!Number.isFinite(cachedAt)) {
    await metadataCache.delete(request);
    return null;
  }

  return cachedAt;
}

async function isImageCacheEntryFresh(request) {
  const cachedAt = await getImageCachedAt(request);
  if (cachedAt === null) {
    await setImageCachedAt(request);
    return true;
  }
  return Date.now() - cachedAt <= IMAGE_CACHE_TTL_MS;
}

/**
 * Process the image request queue
 */
function processImageQueue() {
  while (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS && imageRequestQueue.length > 0) {
    const { request, cacheKey, resolve, reject } = imageRequestQueue.shift();
    activeImageRequests++;

    fetchAndCacheImage(request, cacheKey)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeImageRequests--;
        // Small delay before processing next to avoid burst
        setTimeout(processImageQueue, REQUEST_DELAY_MS);
      });
  }
}

/**
 * Fetch image from network (with token) and cache it under the
 * token-stripped cache key. Only 200 responses are cached.
 */
async function fetchAndCacheImage(request, cacheKey) {
  const cache = await caches.open(IMAGE_CACHE_NAME);

  try {
    const networkResponse = await fetch(request);

    // Cache successful responses
    if (networkResponse.status === 200) {
      // Clone before caching (response can only be consumed once)
      cache.put(cacheKey, networkResponse.clone());
      setImageCachedAt(cacheKey);

      // Trim cache in background (don't block response)
      trimCache(IMAGE_CACHE_NAME, MAX_IMAGE_CACHE_ENTRIES);
    }

    return networkResponse;
  } catch {
    // Network failed, return a placeholder or error
    return new Response('Image unavailable', { status: 503 });
  }
}

/**
 * Queue an image request with throttling
 */
function queueImageRequest(request, cacheKey) {
  return new Promise((resolve, reject) => {
    imageRequestQueue.push({ request, cacheKey, resolve, reject });
    processImageQueue();
  });
}

// Install event - cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
});

// Activate updates only when explicitly requested by the client.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== IMAGE_CACHE_NAME && name !== IMAGE_METADATA_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) URLs (chrome-extension://, etc.)
  if (!url.protocol.startsWith('http')) return;

  // Skip streaming endpoints
  if (url.pathname.includes('/stream')) return;

  // Avoid intercepting Next.js route transitions and navigation documents.
  // Let the browser/Next runtime fetch these directly so route changes are never
  // queued behind image cache activity.
  const isNextRouteRequest =
    request.mode === 'navigate' ||
    request.headers.get('RSC') === '1' ||
    request.headers.has('Next-Router-State-Tree') ||
    request.headers.has('Next-Url') ||
    request.headers.has('Next-Router-Prefetch');
  if (isNextRouteRequest) return;

  // Skip Next.js runtime/static asset requests.
  if (url.pathname.startsWith('/_next/')) return;

  // Skip Next.js image optimization endpoint
  if (url.pathname.startsWith('/_next/image')) return;

  // Handle image routes with cache-first strategy + request throttling
  if (isImageRoute(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE_NAME);
        const metadataCache = await caches.open(IMAGE_METADATA_CACHE_NAME);
        // Key the cache on the token-stripped URL so daily token rotation
        // doesn't re-download the whole art cache.
        const cacheKey = getImageCacheKey(request, url);

        // Try cache first (ignoreVary: the same browser always sends the
        // same Accept header for image requests)
        const cachedResponse = await cache.match(cacheKey, { ignoreVary: true });
        if (cachedResponse) {
          const isFresh = await isImageCacheEntryFresh(cacheKey);
          if (isFresh) {
            return cachedResponse;
          }
          await cache.delete(cacheKey, { ignoreVary: true });
          await metadataCache.delete(cacheKey, { ignoreVary: true });
        }

        // Not in cache, queue the request with throttling
        return queueImageRequest(request, cacheKey);
      })()
    );
    return;
  }

  // Skip other API requests - always go to network
  if (url.pathname.startsWith('/api/')) return;

  // For everything else, try network first, then cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Clone the response before caching
        const responseClone = response.clone();

        // Cache successful responses
        if (response.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }

        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          // Return a fallback for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('/');
          }

          return new Response('Offline', { status: 503 });
        });
      })
  );
});
