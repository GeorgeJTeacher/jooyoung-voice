export function roomFromUrl() {
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(room)) throw new Error('유효한 방 코드가 없습니다.');
  return room;
}

export function guideTokenFromHash() {
  const token = location.hash.replace(/^#/, '');
  if (!token) throw new Error('가이드 권한 토큰이 없습니다. 새 방을 다시 만들어주세요.');
  return token;
}

export async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (token) options.headers['X-Guide-Token'] = token;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      options.body = body;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(path, options);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' && data?.error ? data.error : String(data || `HTTP ${response.status}`);
    throw new Error(message);
  }
  return data;
}

export function wsUrl(path) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let iceServersPromise;
export function getIceServers(room) {
  iceServersPromise ||= api(`/api/rooms/${room}/rtc/ice-servers`).then((data) => data.iceServers);
  return iceServersPromise;
}

export function makeId(prefix = 'id') {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function showToast(element, message, ms = 1800) {
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => element.classList.remove('show'), ms);
}

export function showFatalError(title, error) {
  const main = document.createElement('main');
  main.className = 'empty-document';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const detail = document.createElement('p');
  detail.textContent = error?.message || '알 수 없는 오류가 발생했습니다.';
  main.append(heading, detail);
  document.body.replaceChildren(main);
}

export function waitForIceGatheringComplete(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen');
  } catch { /* optional enhancement */ }
  return null;
}
