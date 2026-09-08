export function homeControlBasePath(pathname = globalThis.location?.pathname ?? '/') {
  return pathname === '/home' || pathname.startsWith('/home/') ? '/home' : '';
}

export function homeControlPath(pathname, locationPathname) {
  return `${homeControlBasePath(locationPathname)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
