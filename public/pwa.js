import { homeControlBasePath, homeControlPath } from './base-path.js';

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    const basePath = homeControlBasePath();
    navigator.serviceWorker.register(homeControlPath('/service-worker.js'), { scope: `${basePath}/` }).catch((registrationError) => {
      console.error('Registrazione PWA Home Control non riuscita:', registrationError);
    });
  });
}
