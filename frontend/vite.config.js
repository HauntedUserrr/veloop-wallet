import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function productionCsp(apiUrl) {
  let apiOrigin = '';
  if (apiUrl) {
    const url = new URL(apiUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('VITE_API_URL must be an HTTPS origin or a local HTTP origin.');
    }
    apiOrigin = ` ${url.origin}`;
  }
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${apiOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'wallet-production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const plugins = [react()];
  if (command === 'build') plugins.push(productionCsp(loadEnv(mode, process.cwd()).VITE_API_URL));
  return {
    plugins,
    server: {
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:4000' },
    },
  };
});
