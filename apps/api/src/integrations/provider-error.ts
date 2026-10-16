// Clasificación compartida por transportes; nunca contiene respuestas o secretos del proveedor.
export class ProviderError extends Error {
  constructor(
    message: string,
    public disposition: 'RETRY' | 'FAILED' | 'REVIEW',
  ) {
    super(message);
  }
}
