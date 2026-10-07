import type { FormEvent } from 'react';
import { api } from '../../lib/api';
import { type RunAction } from './admin.types';
type Props = { policy: string; setPolicy: (value: string) => void; run: RunAction; busy: boolean };
export function AdminWarranty({ policy, setPolicy, run, busy }: Props) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    run(async () => {
      await api('admin/warranty-policy', {
        method: 'PATCH',
        body: JSON.stringify({ text: policy }),
      });
    });
  }

  return (
    <form className="editor" onSubmit={handleSubmit}>
      <h2>Políticas de garantía</h2>
      <p>
        Estas condiciones se publicarán en el footer. No cambian las garantías ya registradas en
        trabajos anteriores.
      </p>
      <label>
        Texto público
        <textarea
          required
          minLength={10}
          maxLength={10000}
          rows={12}
          value={policy}
          onChange={(e) => setPolicy(e.target.value)}
        />
      </label>
      <button className="button" disabled={busy}>
        Publicar políticas
      </button>
    </form>
  );
}
