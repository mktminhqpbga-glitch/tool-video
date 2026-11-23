const key = document.querySelector('#key');
const status = document.querySelector('#status');
async function load() {
  const data = await chrome.storage.local.get(['extensionKey', 'lastStatus']);
  key.value = data.extensionKey || '';
  status.textContent = data.lastStatus || 'Chưa có kết nối.';
}
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  await chrome.storage.local.set({ extensionKey: key.value.trim(), lastStatus: 'Đang kiểm tra…' });
  await chrome.runtime.sendMessage({ type: 'process' }).catch(() => {});
  await load();
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.lastStatus) status.textContent = changes.lastStatus.newValue;
});
void load();
