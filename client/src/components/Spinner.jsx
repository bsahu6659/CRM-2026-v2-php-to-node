export function Spinner({ large = false }) {
  return <span className={large ? 'spinner lg' : 'spinner'} />;
}

export function PageLoader({ label = 'Loading…' }) {
  return (
    <div className="page-loader" style={{ width: '100%' }}>
      <Spinner large />
      <span className="muted">{label}</span>
    </div>
  );
}

export default Spinner;
