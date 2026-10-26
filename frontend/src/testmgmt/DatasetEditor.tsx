export type DatasetParameter = { name: string; type: 'TEXT' | 'LIST'; value?: string; values?: string[] };
export type DatasetRow = { id: string; values: Record<string, string> };
export type Dataset = { schema?: 1; mode?: 'ROWS' | 'COMBINATORIAL'; parameters: DatasetParameter[]; rows?: DatasetRow[] };

/** Controlled editor; dataset bytes are saved and versioned with the test. */
export default function DatasetEditor({ value, onChange, disabled = false }: {
  value?: Dataset | null; onChange: (value: Dataset | null) => void; disabled?: boolean;
}) {
  const dataset: Dataset = value ?? { schema: 1, mode: 'ROWS', parameters: [], rows: [] };
  const rows = dataset.rows ?? [];
  const names = dataset.parameters.map(p => p.name);
  const invalid = names.some(n => !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(n) || ['constructor', 'prototype', '__proto__'].includes(n)) || new Set(names).size !== names.length;
  const count = dataset.mode === 'COMBINATORIAL' ? dataset.parameters.reduce((n, p) => n * (p.type === 'LIST' ? p.values?.length ?? 0 : 1), 1) : rows.length;
  const change = (patch: Partial<Dataset>) => onChange({ ...dataset, ...patch, schema: 1 });
  const addParameter = () => {
    let n = dataset.parameters.length + 1; while (names.includes(`parameter${n}`)) n++;
    const name = `parameter${n}`;
    change({ parameters: [...dataset.parameters, { name, type: 'TEXT', value: '' }], rows: rows.length
      ? rows.map(row => ({ ...row, values: { ...row.values, [name]: '' } })) : [{ id: 'i1', values: { [name]: '' } }] });
  };
  const parameter = (index: number, patch: Partial<DatasetParameter>) => {
    const old = dataset.parameters[index];
    change({ parameters: dataset.parameters.map((p, i) => i === index ? { ...p, ...patch } : p), rows: patch.name != null && patch.name !== old.name
      ? rows.map(row => { const values = { ...row.values }; delete values[old.name]; values[patch.name!] = row.values[old.name] ?? ''; return { ...row, values }; }) : rows });
  };
  const removeParameter = (index: number) => {
    const parameters = dataset.parameters.filter((_, i) => i !== index);
    if (!parameters.length) { onChange(null); return; }
    const name = dataset.parameters[index].name;
    change({ parameters, rows: rows.map(row => { const values = { ...row.values }; delete values[name]; return { ...row, values }; }) });
  };
  const addRow = () => {
    let n = rows.length + 1; while (rows.some(row => row.id === `i${n}`)) n++;
    change({ rows: [...rows, { id: `i${n}`, values: Object.fromEntries(dataset.parameters.map(p => [p.name, p.type === 'LIST' ? p.values?.[0] ?? '' : p.value ?? ''])) }] });
  };
  return <section aria-label="Test dataset">
    <h3 className="tm-subheading">Parameters and iterations</h3>
    <p className="va-subtlest">Use {'{{parameter}}'} in steps. Values are frozen when you publish.</p>
    {invalid && <p role="alert">Parameter names must be unique and begin with a letter.</p>}
    {count > 100 && <p role="alert">This dataset exceeds 100 iterations. Split it before saving.</p>}
    <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
      {!!dataset.parameters.length && <label className="va-field"><span className="va-label">Iteration mode</span>
        <select className="va-input" aria-label="Iteration mode" value={dataset.mode ?? 'ROWS'} onChange={e => change({ mode: e.target.value as Dataset['mode'], rows: e.target.value === 'COMBINATORIAL' ? [] : [{ id: 'i1', values: Object.fromEntries(dataset.parameters.map(p => [p.name, p.value ?? p.values?.[0] ?? ''])) }] })}>
          <option value="ROWS">Explicit dataset rows</option><option value="COMBINATORIAL">All value combinations</option>
        </select></label>}
      {dataset.parameters.map((p, index) => <div className="tm-dataset-parameter" key={index}>
        <label className="va-field"><span className="va-label">Parameter {index + 1}</span><input className="va-input" aria-label={`Parameter ${index + 1} name`} maxLength={32} value={p.name} onChange={e => parameter(index, { name: e.target.value })} /></label>
        <label className="va-field"><span className="va-label">Parameter type</span><select className="va-input" aria-label={`Parameter ${index + 1} type`} value={p.type} onChange={e => parameter(index, e.target.value === 'LIST' ? { type: 'LIST', values: p.values ?? [''] } : { type: 'TEXT', value: p.value ?? '' })}>
          <option value="TEXT">Text</option><option value="LIST">Value list</option></select></label>
        {p.type === 'LIST' && <label className="va-field"><span className="va-label">Allowed values, one per line</span><textarea className="va-input" aria-label={`Parameter ${index + 1} values`} rows={3} value={(p.values ?? []).join('\n')} onChange={e => parameter(index, { values: e.target.value.split('\n') })} /></label>}
        {p.type === 'TEXT' && dataset.mode === 'COMBINATORIAL' && <label className="va-field"><span className="va-label">Fixed text value</span><input className="va-input" aria-label={`Parameter ${index + 1} value`} maxLength={4000} value={p.value ?? ''} onChange={e => parameter(index, { value: e.target.value })} /></label>}
        <button type="button" className="va-button" onClick={() => removeParameter(index)}>Remove parameter {index + 1}</button>
      </div>)}
      {dataset.parameters.length < 20 && <button type="button" className="va-button" onClick={addParameter}>Add parameter</button>}
      {!!dataset.parameters.length && dataset.mode !== 'COMBINATORIAL' && <>
        <div className="tm-table-scroll" tabIndex={0}><table className="va-table"><thead><tr><th>Iteration id</th>{dataset.parameters.map((p, i) => <th key={i}>{p.name}</th>)}<th /></tr></thead><tbody>
          {rows.map((row, index) => <tr key={index}>
            <td><input className="va-input" aria-label={`Iteration ${index + 1} id`} value={row.id} maxLength={32} onChange={e => change({ rows: rows.map((r, i) => i === index ? { ...r, id: e.target.value } : r) })} /></td>
            {dataset.parameters.map((p, i) => <td key={i}>{p.type === 'LIST'
              ? <select className="va-input" aria-label={`Iteration ${row.id} ${p.name}`} value={row.values[p.name] ?? ''} onChange={e => change({ rows: rows.map((r, j) => j === index ? { ...r, values: { ...r.values, [p.name]: e.target.value } } : r) })}>{(p.values ?? []).map((v, k) => <option key={k} value={v}>{v || '(empty)'}</option>)}</select>
              : <input className="va-input" aria-label={`Iteration ${row.id} ${p.name}`} maxLength={4000} value={row.values[p.name] ?? ''} onChange={e => change({ rows: rows.map((r, j) => j === index ? { ...r, values: { ...r.values, [p.name]: e.target.value } } : r) })} />}</td>)}
            <td><button type="button" className="va-button" aria-label={`Remove iteration ${row.id}`} onClick={() => change({ rows: rows.filter((_, i) => i !== index) })}>Remove</button></td>
          </tr>)}
        </tbody></table></div>
        <button type="button" className="va-button" disabled={rows.length >= 100} onClick={addRow}>Add iteration</button>
      </>}
      {!!dataset.parameters.length && <button type="button" className="va-button" onClick={() => onChange(null)}>Remove dataset</button>}
    </fieldset>
    {dataset.parameters.length ? <p>{count} iteration{count === 1 ? '' : 's'}. Maximum 100 iterations and 1,000 expanded steps.</p> : <p className="va-subtlest">No dataset. This test runs once with its original steps.</p>}
  </section>;
}
