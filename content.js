// content.js
const runtime = typeof browser !== 'undefined' ? browser : chrome;

// Cache for user locations - persistent storage
let locationCache = new Map();
const CACHE_KEY = 'twitter_location_cache';
const CACHE_EXPIRY_DAYS = 30; // Cache for 30 days

// Rate limiting
const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000;
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;
let rateLimitResetTime = 0;

// Observer for dynamically loaded content
let observer = null;

// Extension enabled state
let extensionEnabled = true;
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

// Track usernames currently being processed
const processingUsernames = new Set();

// Load enabled state
async function loadEnabledState() {
  try {
    const result = await runtime.storage.local.get([TOGGLE_KEY]);
    extensionEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  } catch (error) {
    console.error('Error loading enabled state:', error);
    extensionEnabled = DEFAULT_ENABLED;
  }
}

// Listen for toggle changes from popup
runtime.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'extensionToggle') {
    extensionEnabled = request.enabled;
    if (extensionEnabled) {
      setTimeout(() => processUsernames(), 500);
    } else {
      removeAllFlags();
    }
  }
});

// Load cache from persistent storage
async function loadCache() {
  try {
    if (!runtime.runtime?.id) return;
    
    const result = await runtime.storage.local.get(CACHE_KEY);
    if (result[CACHE_KEY]) {
      const cached = result[CACHE_KEY];
      const now = Date.now();
      for (const [username, data] of Object.entries(cached)) {
        if (data.expiry && data.expiry > now && data.location !== null) {
          locationCache.set(username, data.location);
        }
      }
    }
  } catch (error) {
    console.log('Cache load skipped or context invalidated');
  }
}

// Save cache to persistent storage
async function saveCache() {
  try {
    if (!runtime.runtime?.id) return;
    
    const cacheObj = {};
    const now = Date.now();
    const expiry = now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    
    for (const [username, location] of locationCache.entries()) {
      cacheObj[username] = {
        location: location,
        expiry: expiry,
        cachedAt: now
      };
    }
    
    await runtime.storage.local.set({ [CACHE_KEY]: cacheObj });
  } catch (error) {
    console.log('Cache save skipped');
  }
}

// Save a single entry to cache
async function saveCacheEntry(username, location) {
  if (!runtime.runtime?.id) return;
  
  locationCache.set(username, location);
  if (!saveCache.timeout) {
    saveCache.timeout = setTimeout(async () => {
      await saveCache();
      saveCache.timeout = null;
    }, 5000);
  }
}

// Inject script into page context
function injectPageScript() {
  // Firefox compatibility: Ensure we use the runtime getURL
  const scriptUrl = runtime.runtime.getURL('pageScript.js');
  
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__rateLimitInfo') {
      rateLimitResetTime = event.data.resetTime;
      const waitTime = event.data.waitTime;
      console.log(`Rate limit detected. Resuming in ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }
  });
}

// Process request queue with rate limiting
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  
  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;
      setTimeout(processRequestQueue, Math.min(waitTime, 60000));
      return;
    } else {
      rateLimitResetTime = 0;
    }
  }
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    
    const { screenName, resolve, reject } = requestQueue.shift();
    activeRequests++;
    lastRequestTime = Date.now();
    
    makeLocationRequest(screenName)
      .then(location => resolve(location))
      .catch(error => reject(error))
      .finally(() => {
        activeRequests--;
        setTimeout(processRequestQueue, 200);
      });
  }
  
  isProcessingQueue = false;
}

// Make actual API request
function makeLocationRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();
    
    const handler = (event) => {
      if (event.source !== window) return;
      
      if (event.data && 
          event.data.type === '__locationResponse' &&
          event.data.screenName === screenName && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        const location = event.data.location;
        const isRateLimited = event.data.isRateLimited || false;
        
        if (!isRateLimited) {
          saveCacheEntry(screenName, location || null);
        }
        
        resolve(location || null);
      }
    };
    window.addEventListener('message', handler);
    
    // In Firefox content scripts, window.postMessage targets the page window correctly
    window.postMessage({
      type: '__fetchLocation',
      screenName,
      requestId
    }, '*');
    
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 10000);
  });
}

async function getUserLocation(screenName) {
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    if (cached !== null) {
      return cached;
    } else {
      locationCache.delete(screenName);
    }
  }
  
  return new Promise((resolve, reject) => {
    requestQueue.push({ screenName, resolve, reject });
    processRequestQueue();
  });
}

function extractUsername(element) {
  const usernameElement = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1];
        const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities'];
        if (!excludedRoutes.includes(username) && 
            !username.startsWith('hashtag') &&
            !username.startsWith('search') &&
            username.length > 0 &&
            username.length < 20) { 
          return username;
        }
      }
    }
  }
  
  // Fallback extraction logic
  const allLinks = element.querySelectorAll('a[href^="/"]');
  const seenUsernames = new Set();
  
  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const match = href.match(/^\/([^\/\?]+)/);
    if (!match || !match[1]) continue;
    
    const potentialUsername = match[1];
    if (seenUsernames.has(potentialUsername)) continue;
    seenUsernames.add(potentialUsername);
    
    const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities', 'hashtag'];
    if (excludedRoutes.some(route => potentialUsername === route || potentialUsername.startsWith(route))) continue;
    if (potentialUsername.includes('status') || potentialUsername.match(/^\d+$/)) continue;
    
    const text = link.textContent?.trim() || '';
    if (text.startsWith('@') || text.toLowerCase() === `@${potentialUsername.toLowerCase()}`) {
      return potentialUsername;
    }
  }
  
  return null;
}

function findHandleSection(container, screenName) {
  return Array.from(container.querySelectorAll('div')).find(div => {
    const link = div.querySelector(`a[href="/${screenName}"]`);
    if (link) {
      const text = link.textContent?.trim();
      return text === `@${screenName}`;
    }
    return false;
  });
}

function createLoadingShimmer() {
  const shimmer = document.createElement('span');
  shimmer.setAttribute('data-twitter-flag-shimmer', 'true');
  shimmer.style.cssText = `
    display: inline-block; width: 20px; height: 16px; margin: 0 4px; 
    vertical-align: middle; border-radius: 2px;
    background: linear-gradient(90deg, rgba(113, 118, 123, 0.2) 25%, rgba(113, 118, 123, 0.4) 50%, rgba(113, 118, 123, 0.2) 75%);
    background-size: 200% 100%; animation: shimmer 1.5s infinite;
  `;
  
  if (!document.getElementById('twitter-flag-shimmer-style')) {
    const style = document.createElement('style');
    style.id = 'twitter-flag-shimmer-style';
    style.textContent = `@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }`;
    document.head.appendChild(style);
  }
  return shimmer;
}

async function addFlagToUsername(usernameElement, screenName) {
  if (usernameElement.dataset.flagAdded === 'true') return;
  if (processingUsernames.has(screenName)) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (usernameElement.dataset.flagAdded === 'true') return;
    usernameElement.dataset.flagAdded = 'waiting';
    return;
  }

  usernameElement.dataset.flagAdded = 'processing';
  processingUsernames.add(screenName);
  
  const userNameContainer = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  const shimmerSpan = createLoadingShimmer();
  let shimmerInserted = false;
  
  if (userNameContainer) {
    const handleSection = findHandleSection(userNameContainer, screenName);
    if (handleSection && handleSection.parentNode) {
      try {
        handleSection.parentNode.insertBefore(shimmerSpan, handleSection);
        shimmerInserted = true;
      } catch (e) {
        userNameContainer.appendChild(shimmerSpan);
        shimmerInserted = true;
      }
    } else {
      userNameContainer.appendChild(shimmerSpan);
      shimmerInserted = true;
    }
  }
  
  try {
    const location = await getUserLocation(screenName);
    if (shimmerInserted && shimmerSpan.parentNode) shimmerSpan.remove();
    
    if (!location) {
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    const flag = getCountryFlag(location);
    if (!flag) {
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    if (usernameElement.querySelector('[data-twitter-flag]')) {
      usernameElement.dataset.flagAdded = 'true';
      return;
    }

    const flagSpan = document.createElement('span');
    flagSpan.textContent = ` ${flag}`;
    flagSpan.setAttribute('data-twitter-flag', 'true');
    flagSpan.style.cssText = 'margin: 0 4px; display: inline; color: inherit; vertical-align: middle;';
    
    const containerForFlag = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    
    if (!containerForFlag) {
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }
    
    const handleSection = findHandleSection(containerForFlag, screenName);
    let inserted = false;
    
    if (handleSection && handleSection.parentNode === containerForFlag) {
      containerForFlag.insertBefore(flagSpan, handleSection);
      inserted = true;
    } else if (handleSection && handleSection.parentNode && handleSection.parentNode !== containerForFlag) {
       handleSection.parentNode.parentNode.insertBefore(flagSpan, handleSection.parentNode);
       inserted = true;
    } else {
      containerForFlag.appendChild(flagSpan);
      inserted = true;
    }
    
    if (inserted) {
      usernameElement.dataset.flagAdded = 'true';
      const waitingContainers = document.querySelectorAll(`[data-flag-added="waiting"]`);
      waitingContainers.forEach(container => {
        if (extractUsername(container) === screenName) {
          addFlagToUsername(container, screenName).catch(() => {});
        }
      });
    } else {
      usernameElement.dataset.flagAdded = 'failed';
    }
  } catch (error) {
    if (shimmerInserted && shimmerSpan.parentNode) shimmerSpan.remove();
    usernameElement.dataset.flagAdded = 'failed';
  } finally {
    processingUsernames.delete(screenName);
  }
}

function removeAllFlags() {
  document.querySelectorAll('[data-twitter-flag]').forEach(flag => flag.remove());
  document.querySelectorAll('[data-twitter-flag-shimmer]').forEach(shimmer => shimmer.remove());
  document.querySelectorAll('[data-flag-added]').forEach(container => delete container.dataset.flagAdded);
}

async function processUsernames() {
  if (!extensionEnabled) return;
  
  const containers = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]');
  
  for (const container of containers) {
    const screenName = extractUsername(container);
    if (screenName) {
      const status = container.dataset.flagAdded;
      if (!status || status === 'failed') {
        addFlagToUsername(container, screenName).catch(err => {
          container.dataset.flagAdded = 'failed';
        });
      }
    }
  }
}

function initObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    if (!extensionEnabled) return;
    if (mutations.some(m => m.addedNodes.length > 0)) {
      setTimeout(processUsernames, 500);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function init() {
  await loadEnabledState();
  await loadCache();
  
  if (!extensionEnabled) return;
  
  injectPageScript();
  
  setTimeout(processUsernames, 2000);
  initObserver();
  
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(processUsernames, 2000);
    }
  }).observe(document, { subtree: true, childList: true });
  
  setInterval(saveCache, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}