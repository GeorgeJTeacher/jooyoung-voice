import { api } from './shared/api.js';

const form = document.querySelector('#create-form');
const message = document.querySelector('#create-message');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '방을 만드는 중…';
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const title = document.querySelector('#room-title').value.trim();
    const createKey = document.querySelector('#create-key').value;
    const listenerPassword = document.querySelector('#listener-password').value;
    const expiresHours = Number(document.querySelector('#expires-hours').value);
    const data = await api('/api/rooms', {
      method: 'POST',
      body: { title, expiresHours, listenerPassword },
      headers: { 'X-Create-Key': createKey },
    });
    location.href = `${data.guideUrl}#${data.guideToken}`;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
