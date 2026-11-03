const byId = id => document.getElementById(id);

window.wihmSetup.load().then(({ strings, language, server, proxy, error }) => {
  document.documentElement.lang = language;
  document.documentElement.dir = strings.dir;
  for (const [id, key] of [['title', 'title'], ['intro', 'intro'], ['server-label', 'server'], ['proxy-label', 'useProxy'], ['type-label', 'proxyType'], ['host-label', 'host'], ['port-label', 'port'], ['proxy-help', 'proxyHelp'], ['connect', 'connect'], ['back', 'back']]) byId(id).textContent = strings[key];
  byId('server').value = server;
  byId('use-proxy').checked = proxy.enabled === true;
  byId('proxy-type').value = proxy.type || 'socks5';
  byId('proxy-host').value = proxy.host || '';
  byId('proxy-port').value = proxy.port || '';
  byId('proxy-fields').hidden = !byId('use-proxy').checked;
  byId('error').textContent = error;
  // Only a saved server has somewhere to go back to, and nothing typed here is kept.
  byId('back').hidden = !server;
});

byId('back').addEventListener('click', () => window.wihmSetup.back());

byId('use-proxy').addEventListener('change', () => { byId('proxy-fields').hidden = !byId('use-proxy').checked; });

byId('form').addEventListener('submit', async event => {
  event.preventDefault();
  byId('connect').disabled = true;
  byId('error').textContent = '';
  const { error } = await window.wihmSetup.connect({
    server: byId('server').value,
    proxy: { enabled: byId('use-proxy').checked, type: byId('proxy-type').value, host: byId('proxy-host').value, port: byId('proxy-port').value },
  });
  byId('connect').disabled = false;
  if (error) byId('error').textContent = error;
});
