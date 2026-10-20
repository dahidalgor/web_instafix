/** Enlaces de correo: #restablecer?token=… y #verificar-correo?token=… */
export function linkToken(page: string) {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?');
  return path === page ? new URLSearchParams(query || '').get('token') || '' : '';
}
