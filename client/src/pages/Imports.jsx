/**
 * CSV import: upload, map columns, preview, then execute with a duplicate
 * policy. The whole flow lives in one wizard so the user never loses their file
 * between steps. Port of the PHP edition's `js/views/imports.js`.
 */
import { useRef, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { loadReference } from '../lib/reference.js';
import { emitDataChanged } from '../lib/events.js';
import { number, dateTime, relative, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { PageHead, NoAccess } from '../components/shared.jsx';
import {
  Alert,
  DataTable,
  Dropdown,
  Field,
  MenuItem,
  Modal,
  Select,
  SwitchToggle,
  reportError,
  toast,
} from '../components/ui/index.js';

const STATUS_BADGE = { COMPLETED: 'badge-success', FAILED: 'badge-danger', RUNNING: 'badge-info' };

const DUPLICATE_OPTIONS = [
  { value: 'SKIP', label: 'Skip the row (recommended)' },
  { value: 'UPDATE', label: 'Update the existing lead' },
  { value: 'IMPORT', label: 'Import it anyway' },
];

export default function Imports() {
  const { can } = useAuth();
  if (!can('imports', 'read')) return <NoAccess what="data import" />;
  return <ImportsPage />;
}

function ImportsPage() {
  const { can } = useAuth();
  const tableRef = useRef(null);
  // { reference, targetFields } while the wizard is open.
  const [wizard, setWizard] = useState(null);
  const [details, setDetails] = useState(null);

  // The original loaded reference data and the mappable fields before opening
  // the dialog, so the mapping step never waits on them.
  async function startImport() {
    const reference = await loadReference();
    const targetFields = await api.data('/api/imports/target-fields').catch(() => []);
    setWizard({ reference, targetFields });
  }

  const actions = [
    <button
      key="template"
      type="button"
      className="btn"
      onClick={() =>
        api
          .download('/api/imports/template.csv', null, 'growvanta-lead-import-template.csv')
          .then(() => toast.success('Template downloaded'))
          .catch(reportError)
      }
    >
      <Icon name="download" size={15} />
      Download template
    </button>,
    can('leads', 'export') ? (
      <button
        key="export"
        type="button"
        className="btn"
        onClick={() =>
          api
            .download('/api/leads/export')
            .then(() => toast.success('Leads exported'))
            .catch(reportError)
        }
      >
        <Icon name="export" size={15} />
        Export all leads
      </button>
    ) : null,
    can('imports', 'create') ? (
      <button key="import" type="button" className="btn btn-primary" onClick={startImport}>
        <Icon name="upload" size={15} />
        Import leads
      </button>
    ) : null,
  ].filter(Boolean);

  const columns = [
    {
      label: 'File',
      render: (row) => (
        <div>
          <div className="cell-main truncate">{row.fileName}</div>
          <div className="cell-sub">{`${relative(row.createdAt)}${row.createdBy ? ` · ${row.createdBy.firstName}` : ''}`}</div>
        </div>
      ),
    },
    {
      label: 'Status',
      render: (row) => <span className={`badge ${STATUS_BADGE[row.status] || ''}`}>{titleCase(row.status)}</span>,
    },
    { label: 'Rows', cellClass: 'right', render: (row) => number(row.totalRows) },
    {
      label: 'Created',
      cellClass: 'right',
      render: (row) => <span className="text-success strong">{number(row.createdRows)}</span>,
    },
    { label: 'Updated', cellClass: 'right hide-sm', render: (row) => number(row.updatedRows) },
    { label: 'Duplicates', cellClass: 'right hide-sm', render: (row) => number(row.duplicateRows) },
    {
      label: 'Errors',
      cellClass: 'right',
      render: (row) =>
        row.errorRows > 0 ? (
          <span className="text-danger strong">{number(row.errorRows)}</span>
        ) : (
          <span className="muted">0</span>
        ),
    },
    {
      label: '',
      width: '48px',
      render: (row) => (
        <Dropdown
          trigger={
            <button type="button" className="icon-btn" aria-label="Import actions">
              <Icon name="more" size={16} />
            </button>
          }
        >
          <MenuItem iconName="eye" onClick={() => setDetails(row)}>
            View details
          </MenuItem>
          {row.errorRows > 0 ? (
            <MenuItem
              iconName="download"
              onClick={() =>
                api.download(`/api/imports/${row.id}/errors.csv`, null, `import-errors-${row.id}.csv`).catch(reportError)
              }
            >
              Download error report
            </MenuItem>
          ) : null}
        </Dropdown>
      ),
    },
  ];

  return (
    <div>
      <PageHead title="Import & Export" subtitle="Bring leads in from a CSV, or take your data out." actions={actions} />
      <div>
        <DataTable
          ref={tableRef}
          columns={columns}
          load={(params) => api.get('/api/imports', params)}
          emptyTitle="No imports yet"
          emptyMessage="Upload a CSV to bring leads in. Every row is de-duplicated and routed like a normal lead."
          emptyAction={
            can('imports', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={startImport}>
                Import a file
              </button>
            ) : null
          }
        />
      </div>

      {details ? <JobDetails job={details} onClose={() => setDetails(null)} /> : null}
      {wizard ? (
        <ImportWizard
          reference={wizard.reference}
          targetFields={wizard.targetFields}
          onClose={() => setWizard(null)}
          onImported={() => tableRef.current?.refresh()}
        />
      ) : null}
    </div>
  );
}

/** KPI-style tile without the accent bar, as the original's local `stat()`. */
function Stat({ label, value }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
    </div>
  );
}

function JobDetails({ job, onClose }) {
  return (
    <Modal
      title={job.fileName}
      subtitle={`${dateTime(job.createdAt)} · ${titleCase(job.status)}`}
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div>
        <div className="kpi-grid mb-16">
          <Stat label="Total rows" value={number(job.totalRows)} />
          <Stat label="Created" value={number(job.createdRows)} />
          <Stat label="Updated" value={number(job.updatedRows)} />
          <Stat label="Duplicates" value={number(job.duplicateRows)} />
          <Stat label="Errors" value={number(job.errorRows)} />
        </div>
        <h4 className="mb-8">Column mapping</h4>
        <div className="code-block mb-16">{JSON.stringify(job.mapping, null, 2)}</div>
        {job.errors?.length ? (
          <div>
            <h4 className="mb-8">Row messages</h4>
            <div className="table-wrap" style={{ maxHeight: '280px', overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Level</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {job.errors.map((e, i) => (
                    <tr key={`${e.row}-${i}`}>
                      <td>{String(e.row)}</td>
                      <td>
                        <span className={`badge ${e.level === 'ERROR' ? 'badge-danger' : ''}`}>{e.level}</span>
                      </td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import wizard
// ---------------------------------------------------------------------------

/**
 * Step machine of the original's single "next" button:
 *   choose  → (upload) → mapping → (execute) → running → done | failed
 * A failed run can be retried with the same mapping; "Done" closes the dialog.
 */
function ImportWizard({ reference: ref, targetFields, onClose, onImported }) {
  const fileRef = useRef(null);
  const [step, setStep] = useState('choose');
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [duplicateHandling, setDuplicateHandling] = useState('SKIP');
  const [runAssignment, setRunAssignment] = useState(true);
  const [defaultSourceId, setDefaultSourceId] = useState(() => ref.sources.find((s) => s.key === 'import')?.id || '');
  // Required: a spreadsheet of enquiries is always about something, and the
  // file almost never says what. The server refuses the run without it.
  const [importProjectId, setImportProjectId] = useState('');
  const [job, setJob] = useState(null);
  const [failure, setFailure] = useState('');

  async function uploadPreview() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.warn('Choose a CSV file first');
      return;
    }
    setReading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.upload('/api/imports/preview', formData);
      setPreview(res.data);
      setMapping({ ...res.data.suggestedMapping });
      setStep('mapping');
    } catch (err) {
      reportError(err);
    } finally {
      setReading(false);
    }
  }

  async function runImport() {
    const mapped = Object.values(mapping);
    if (!mapped.includes('firstName')) {
      toast.warn('Map a column to First Name');
      return;
    }
    if (!mapped.includes('email') && !mapped.includes('phone')) {
      toast.warn('Map a column to Email or Phone', 'Needed so duplicates can be detected.');
      return;
    }
    if (!importProjectId) {
      toast.warn('Choose a project', 'Every imported enquiry has to be attached to one.');
      return;
    }

    setStep('running');
    try {
      const res = await api.post('/api/imports/execute', {
        token: preview.token,
        fileName: preview.fileName,
        mapping,
        duplicateHandling,
        defaultSourceId: defaultSourceId || undefined,
        projectId: importProjectId,
        runAssignment,
      });
      setJob(res.data);
      setStep('done');
      onImported();
      emitDataChanged();
    } catch (err) {
      reportError(err);
      setFailure(err.message);
      setStep('failed');
    }
  }

  function onNext() {
    if (step === 'done') {
      onClose();
      onImported();
      return;
    }
    if (!preview) {
      uploadPreview();
      return;
    }
    runImport();
  }

  let nextLabel = 'Import leads';
  if (step === 'choose') nextLabel = reading ? 'Reading…' : 'Upload & preview';
  else if (step === 'running') nextLabel = 'Importing…';
  else if (step === 'done') nextLabel = 'Done';
  const nextDisabled = reading || step === 'running';

  let stepContent = null;
  if (step === 'mapping') {
    stepContent = (
      <MappingStep
        preview={preview}
        targetFields={targetFields}
        reference={ref}
        mapping={mapping}
        setMapping={setMapping}
        duplicateHandling={duplicateHandling}
        setDuplicateHandling={setDuplicateHandling}
        defaultSourceId={defaultSourceId}
        setDefaultSourceId={setDefaultSourceId}
        importProjectId={importProjectId}
        setImportProjectId={setImportProjectId}
        runAssignment={runAssignment}
        setRunAssignment={setRunAssignment}
      />
    );
  } else if (step === 'running') {
    stepContent = (
      <div className="page-loader">
        <span className="spinner lg" />
        <span className="muted">
          {`Importing ${number(preview.totalRows)} rows. This runs duplicate checks, scoring and routing for each one.`}
        </span>
      </div>
    );
  } else if (step === 'done' && job) {
    stepContent = (
      <div className="mt-16">
        <div className={`alert ${job.errorRows ? 'warning' : 'success'} mb-16`}>
          <Icon name={job.errorRows ? 'alert' : 'check'} size={16} />
          <div>
            <strong>Import finished</strong>
            {`${number(job.createdRows)} created · ${number(job.updatedRows)} updated · ${number(job.duplicateRows)} duplicates · ${number(job.errorRows)} errors`}
          </div>
        </div>
        {job.errors?.length ? (
          <div className="table-wrap" style={{ maxHeight: '220px', overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {job.errors.slice(0, 50).map((e, i) => (
                  <tr key={`${e.row}-${i}`}>
                    <td>{String(e.row)}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    );
  } else if (step === 'failed') {
    stepContent = (
      <Alert tone="danger" className="mt-16">
        {failure}
      </Alert>
    );
  }

  return (
    <Modal
      title="Import leads from CSV"
      subtitle="Step 1 of 2 — choose your file"
      size="wide"
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={nextDisabled} onClick={onNext}>
            {nextLabel}
          </button>
        </div>
      }
    >
      <div>
        <div className="alert info mb-16">
          <Icon name="info" size={16} />
          <div>
            <strong>What happens to each row</strong>
            Every row is de-duplicated on phone and email, scored, and routed through your assignment rules — exactly like
            a lead arriving from a form.
          </div>
        </div>
        <Field label="CSV file" hint="Export from Excel or Sheets as CSV. Up to 20,000 rows.">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="input" style={{ paddingTop: '7px' }} />
        </Field>
        <div>{stepContent}</div>
      </div>
    </Modal>
  );
}

function MappingStep({
  preview,
  targetFields,
  reference: ref,
  mapping,
  setMapping,
  duplicateHandling,
  setDuplicateHandling,
  defaultSourceId,
  setDefaultSourceId,
  importProjectId,
  setImportProjectId,
  runAssignment,
  setRunAssignment,
}) {
  const fieldOptions = [{ value: '', label: 'Do not import' }, ...targetFields.map((f) => ({ value: f.key, label: f.label }))];

  const mapColumn = (header, target) =>
    setMapping((prev) => {
      const next = { ...prev };
      if (target) next[header] = target;
      else delete next[header];
      return next;
    });

  return (
    <div className="mt-16">
      <div className="alert success mb-16">
        <Icon name="check" size={16} />
        <div>{`${number(preview.totalRows)} rows found in ${preview.fileName}. Map each column below.`}</div>
      </div>

      <h4 className="mb-8">Column mapping</h4>
      <div className="table-wrap" style={{ maxHeight: '260px', overflowY: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>CSV column</th>
              <th>Sample value</th>
              <th>Maps to</th>
            </tr>
          </thead>
          <tbody>
            {preview.headers.map((header) => (
              <tr key={header}>
                <td className="cell-main">{header}</td>
                <td className="muted small truncate">{preview.sample[0]?.[header] || '—'}</td>
                <td>
                  <Select
                    options={fieldOptions}
                    value={mapping[header] || ''}
                    onChange={(e) => mapColumn(header, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="mt-16 mb-8">Options</h4>
      <div className="form-grid">
        <Field label="When a duplicate is found">
          <Select
            options={DUPLICATE_OPTIONS}
            value={duplicateHandling}
            onChange={(e) => setDuplicateHandling(e.target.value)}
          />
        </Field>
        <Field label="Default lead source" hint="Used when a row has no source of its own.">
          <Select
            options={ref.sources.map((s) => ({ value: s.id, label: s.name }))}
            value={defaultSourceId}
            onChange={(e) => setDefaultSourceId(e.target.value)}
          />
        </Field>
        <Field
          label="Project"
          required
          hint={
            ref.projects.length
              ? 'Applied to every row that does not name its own project.'
              : 'Add a project first - imported leads have to be attached to one.'
          }
        >
          <Select
            options={ref.projects.map((p) => ({ value: p.id, label: p.name }))}
            value={importProjectId}
            placeholder="Which project are these enquiries about?"
            onChange={(e) => setImportProjectId(e.target.value)}
          />
        </Field>
      </div>
      <SwitchToggle label="Run the assignment rules on imported leads" checked={runAssignment} onChange={setRunAssignment} />
    </div>
  );
}
