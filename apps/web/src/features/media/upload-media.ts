import type { Offering } from '@instafix/contracts';

type MediaItem = Offering['media'][number];
type UploadCallbacks = {
  onProgress: (percent: number) => void;
  onProcessing: () => void;
};

/** XHR permite informar del progreso de subida antes de la conversión en el servidor. */
export function uploadMedia(
  file: File,
  type: MediaItem['type'],
  { onProgress, onProcessing }: UploadCallbacks,
): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v1/admin/media');
    request.timeout = 360000;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-Media-Type', type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.upload.onload = onProcessing;
    request.onerror = () => reject(new Error('Se perdió la conexión. Vuelve a intentarlo.'));
    request.ontimeout = () =>
      reject(new Error('El archivo tardó demasiado. Intenta con uno más pequeño.'));
    request.onload = () => {
      try {
        const body = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) {
          resolve(body as MediaItem);
        } else {
          reject(
            new Error(
              typeof body.message === 'string' ? body.message : 'No pudimos subir el archivo.',
            ),
          );
        }
      } catch {
        reject(new Error('No pudimos subir el archivo.'));
      }
    };
    request.send(file);
  });
}
