import type { FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { TextSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import { type RunAction } from './admin.types';
type Props = {
  policy: string;
  setPolicy: (value: string) => void;
  run: RunAction;
  busy: boolean;
  loading?: boolean;
};
export function AdminWarranty({ policy, setPolicy, run, busy, loading }: Props) {
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
      <p>
        Estas condiciones se publicarán en el footer. No cambian las garantías ya registradas en
        trabajos anteriores.
      </p>
      {loading && <TextSkeleton lines={6} label="Cargando políticas…" />}
      <label hidden={loading}>
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
      <BusyButton type="submit" className="button" busy={busy} busyLabel="Publicando…">
        Publicar políticas
      </BusyButton>
    </form>
  );
}
