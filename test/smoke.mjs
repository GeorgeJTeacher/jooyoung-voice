import assert from 'node:assert/strict';

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787';
const createKey = process.env.SMOKE_CREATE_KEY || 'local-smoke-test-key';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function nextMessage(ws, predicate = () => true, timeoutMs = 5000) {
  const queuedIndex = ws._messages.findIndex(predicate);
  if (queuedIndex >= 0) return Promise.resolve(ws._messages.splice(queuedIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket message timeout')), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (error) reject(error); else resolve(value);
    }
    function onMessage(event) {
      const value = JSON.parse(event.data);
      if (predicate(value)) finish(null, value);
      else ws._messages.push(value);
    }
    ws.addEventListener('message', onMessage);
  });
}

async function openSocket(path) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${path}`);
  ws._messages = [];
  ws.addEventListener('message', (event) => ws._messages.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

const wrong = await request('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Create-Key': 'wrong' }, body: '{}' });
assert.equal(wrong.response.status, 403);

const created = await request('/api/rooms', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Create-Key': createKey },
  body: JSON.stringify({ title: 'Smoke test', expiresHours: 2, listenerPassword:'2468' }),
});
assert.equal(created.response.status, 200);
const { roomId, guideToken } = created.body;
assert.match(roomId, /^[A-Z2-9]{6}$/);

const status = await request(`/api/rooms/${roomId}/status`);
assert.equal(status.response.status, 200);
assert.equal(status.body.title, 'Smoke test');
assert.equal(status.body.accessRequired, true);

const deniedAccess=await request(`/api/rooms/${roomId}/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
assert.equal(deniedAccess.response.status,403);
const grantedAccess=await request(`/api/rooms/${roomId}/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'2468'})});
assert.equal(grantedAccess.response.status,200);
const listenerToken=grantedAccess.body.accessToken;
assert.ok(listenerToken);
const noListenerTicket=await request(`/api/rooms/${roomId}/listener-ws-ticket`,{method:'POST'});
assert.equal(noListenerTicket.response.status,403);
const listenerTicket=await request(`/api/rooms/${roomId}/listener-ws-ticket`,{method:'POST',headers:{'X-Listener-Token':listenerToken}});
assert.equal(listenerTicket.response.status,200);

const unauthorized = await request(`/api/rooms/${roomId}/ws-ticket`, { method: 'POST' });
assert.equal(unauthorized.response.status, 403);
const authorized = await request(`/api/rooms/${roomId}/ws-ticket`, { method: 'POST', headers: { 'X-Guide-Token': guideToken } });
assert.equal(authorized.response.status, 200);

const guide = await openSocket(`/api/rooms/${roomId}/ws?role=guide&ticket=${encodeURIComponent(authorized.body.ticket)}`);
const listener = await openSocket(`/api/rooms/${roomId}/ws?role=listener&ticket=${encodeURIComponent(listenerTicket.body.ticket)}`);
const guideHello = await nextMessage(guide, (message) => message.type === 'hello');
const listenerHello = await nextMessage(listener, (message) => message.type === 'hello');
assert.equal(guideHello.meta.roomId, roomId);
assert.equal(listenerHello.meta.roomId, roomId);

const qualityMessage = nextMessage(guide, (message) => message.type === 'quality:summary' && message.good === 1);
listener.send(JSON.stringify({ type:'quality', level:'good', loss:0.4, jitter:12 }));
assert.equal((await qualityMessage).good,1);

const headphoneMessage = nextMessage(guide, (message) => message.type === 'headphones:summary' && message.active === 1);
listener.send(JSON.stringify({ type:'headphones', active:true, source:'manual' }));
assert.equal((await headphoneMessage).listeners,1);

const pageMessage = nextMessage(listener, (message) => message.type === 'page');
guide.send(JSON.stringify({ type: 'page', page: 2 }));
assert.equal((await pageMessage).page, 2);

const focusMessage = nextMessage(listener, (message) => message.type === 'focus');
guide.send(JSON.stringify({ type:'focus', region:{x:.2,y:.3,width:.25,height:.18} }));
assert.deepEqual((await focusMessage).region,{x:.2,y:.3,width:.25,height:.18});

const committed = nextMessage(listener, (message) => message.type === 'stroke:committed');
const stroke = { id: 'smoke-stroke', page: 2, tool: 'pen', color: '#e53935', width: 0.0045, opacity: 1, points: [0.1, 0.2, 0.5, 0.2, 0.3, 0.5] };
guide.send(JSON.stringify({ type: 'stroke:end', id: stroke.id, page: 2, stroke }));
assert.equal((await committed).stroke.id, stroke.id);

const audioTicketMessage = nextMessage(listener, (message) => message.type === 'audio:ticket');
listener.send(JSON.stringify({ type: 'audio:ticket' }));
const audioTicket = (await audioTicketMessage).ticket;
assert.ok(audioTicket);
const firstSubscribe = await request(`/api/rooms/${roomId}/rtc/subscribe`, { method: 'POST', headers: { 'X-Listener-Ticket': audioTicket } });
assert.notEqual(firstSubscribe.response.status, 403);
const replayedSubscribe = await request(`/api/rooms/${roomId}/rtc/subscribe`, { method: 'POST', headers: { 'X-Listener-Ticket': audioTicket } });
assert.equal(replayedSubscribe.response.status, 403);

const badPdf = await request(`/api/rooms/${roomId}/pdf`, { method: 'PUT', headers: { 'X-Guide-Token': guideToken, 'Content-Type': 'text/plain' }, body: 'not a pdf' });
assert.equal(badPdf.response.status, 415);

guide.close();
listener.close();
console.log(`Smoke test passed for room ${roomId}`);
