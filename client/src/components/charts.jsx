/**
 * Hand-rolled SVG charts. Port of the PHP edition's `js/lib/charts.js`.
 *
 * No charting library: the CRM ships a handful of chart types and each is a
 * few dozen lines of SVG, which is smaller and faster than any dependency
 * that would do the same. Everything scales with `viewBox` so charts stay
 * crisp and responsive, and colours come from CSS variables so they follow
 * the theme. Props carry the same names and defaults as the original options.
 */
import { useId, useRef, useState } from 'react';
import { compactNumber, number } from '../lib/format.js';

/* Brand green leads, then the logo's deep green, then hues picked to stay
   distinguishable beside it rather than competing with it. */
export const PALETTE = [
  '#35e06f', '#0f833b', '#0284c7', '#d97706', '#dc2626',
  '#7c3aed', '#0d9488', '#db2777', '#65a30d', '#c2410c',
  '#0891b2', '#9333ea',
];

const TIP_STYLE = {
  position: 'absolute', pointerEvents: 'none',
  background: 'var(--sidebar-bg)', color: '#fff', padding: '6px 9px',
  borderRadius: '7px', fontSize: '11.5px', whiteSpace: 'nowrap',
  transform: 'translate(-50%, -130%)', transition: 'opacity .1s ease', zIndex: 5,
  boxShadow: 'var(--shadow-md)',
};

/** SVG ids must be unique per page and must not contain the colons useId() produces. */
function useSvgId(prefix) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * Multi-series line/area chart.
 * @param series [{ key, label, color, values: number[] }]
 * @param labels x-axis labels, same length as each series' values
 */
export function LineChart({ series, labels, height = 240, area = true, formatValue = number }) {
  const idBase = useSvgId('gvl');
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);

  const width = 760;
  const pad = { top: 16, right: 12, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allValues = series.flatMap((s) => s.values);
  const max = Math.max(1, ...allValues);
  // Round the axis up to a friendly number so gridlines land on whole values.
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step || 1;

  const n = labels.length || 1;
  const x = (i) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => pad.top + plotH - (v / niceMax) * plotH;

  // X labels: thinned so they never collide.
  const every = Math.max(1, Math.ceil(n / 8));
  const bandW = plotW / Math.max(1, n - 1);

  return (
    <div>
      <div className="chart-wrap" ref={wrapRef} style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          // `none` would stretch the axis labels out of shape on a narrow screen;
          // letting it scale uniformly keeps the type legible at every width.
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label="Trend chart"
        >
          {[0, 1, 2, 3, 4].map((i) => {
            const value = (niceMax / 4) * i;
            const yy = y(value);
            return (
              <g key={`grid${i}`}>
                <line x1={pad.left} x2={width - pad.right} y1={yy} y2={yy} stroke="var(--line-2)" strokeWidth={1} />
                <text x={pad.left - 8} y={yy + 4} textAnchor="end" fontSize={10.5} fill="var(--ink-4)">
                  {compactNumber(value)}
                </text>
              </g>
            );
          })}

          {labels.map((label, i) =>
            i % every !== 0 && i !== n - 1 ? null : (
              <text key={`x${i}`} x={x(i)} y={height - 7} textAnchor="middle" fontSize={10.5} fill="var(--ink-4)">
                {label}
              </text>
            )
          )}

          {series.map((s, si) => {
            const color = s.color || PALETTE[si % PALETTE.length];
            const points = s.values.map((v, i) => `${x(i)},${y(v)}`);
            if (!points.length) return null;
            const gradId = `${idBase}-${si}`;
            return (
              <g key={s.key ?? si}>
                {area ? (
                  <>
                    <defs>
                      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path
                      d={`M ${pad.left},${pad.top + plotH} L ${points.join(' L ')} L ${x(s.values.length - 1)},${pad.top + plotH} Z`}
                      fill={`url(#${gradId})`}
                      stroke="none"
                    />
                  </>
                ) : null}
                <polyline
                  points={points.join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={2.25}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {/* One transparent hit-strip per x position keeps hovering cheap and precise. */}
          <g>
            {labels.map((label, i) => (
              <rect
                key={`hit${i}`}
                x={x(i) - bandW / 2}
                y={pad.top}
                width={bandW}
                height={plotH}
                fill="transparent"
                onMouseEnter={(e) => {
                  const rect = wrapRef.current.getBoundingClientRect();
                  const text = `${label} · ${series.map((s) => `${s.label} ${formatValue(s.values[i] ?? 0)}`).join(' · ')}`;
                  setTip({ text, x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseLeave={() => setTip((t) => (t ? { ...t, hidden: true } : t))}
              />
            ))}
          </g>
        </svg>
        <div
          className="chart-tip"
          style={{
            ...TIP_STYLE,
            opacity: tip && !tip.hidden ? 1 : 0,
            left: tip ? `${tip.x}px` : 0,
            top: tip ? `${tip.y}px` : 0,
          }}
        >
          {tip?.text || ''}
        </div>
      </div>
      <div className="legend">
        {series.map((s, si) => (
          <div key={s.key ?? si} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color || PALETTE[si % PALETTE.length] }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Horizontal bar list - better than a vertical bar chart for long category names.
 * @param rows [{ label, value, color? }]
 */
export function BarList({ rows, formatValue = number, colorFn = null, max: maxOverride = null }) {
  const max = maxOverride ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bar-list">
      {rows.map((row, i) => (
        <div key={row.key ?? `${row.label}-${i}`} className="bar-row">
          <div className="bar-top">
            <span className="truncate">{row.label}</span>
            <span className="strong">{formatValue(row.value)}</span>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${Math.max(2, (row.value / max) * 100)}%`,
                background: row.color || colorFn?.(row, i) || PALETTE[i % PALETTE.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Donut with a centre label. Segments are drawn as stroked arcs.
 * @param slices [{ label, value, color? }] - zero-value slices are skipped
 */
export function DonutChart({ slices, size = 190, thickness = 26, centerLabel, centerValue }) {
  const total = slices.reduce((sum, s) => sum + (s.value || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  // A slice's default colour comes from its position in `slices`, for the arc
  // and the legend alike. (The original numbered the legend after dropping
  // empty slices, so an empty slice early in the list shifted every legend
  // swatch away from its arc.)
  const colorOf = (slice, i) => slice.color || PALETTE[i % PALETTE.length];

  let offset = 0;
  const arcs = [];
  slices.forEach((slice, i) => {
    if (!slice.value) return;
    const fraction = total > 0 ? slice.value / total : 0;
    const dash = fraction * circumference;
    arcs.push(
      <circle
        key={`arc${i}`}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={colorOf(slice, i)}
        strokeWidth={thickness}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-offset}
      >
        <title>{`${slice.label}: ${number(slice.value)}`}</title>
      </circle>
    );
    offset += dash;
  });

  return (
    <div className="row" style={{ gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: `${size}px`, height: `${size}px`, flex: `0 0 ${size}px` }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Distribution chart">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-3)"
            strokeWidth={thickness}
          />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>{arcs}</g>
        </svg>
        <div
          style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            textAlign: 'center', pointerEvents: 'none',
          }}
        >
          <div>
            <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.02em' }}>
              {centerValue ?? number(total)}
            </div>
            <div className="muted tiny">{centerLabel || 'Total'}</div>
          </div>
        </div>
      </div>
      <div className="col" style={{ gap: '7px', minWidth: '140px' }}>
        {slices.map((slice, i) =>
          slice.value ? (
            <div key={`leg${i}`} className="legend-item">
              <span className="legend-swatch" style={{ background: colorOf(slice, i) }} />
              <span className="truncate grow">{slice.label}</span>
              <span className="strong small">{number(slice.value)}</span>
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

/**
 * Conversion funnel. Each step is measured against the first for width.
 * @param steps [{ label, value }]
 */
export function FunnelChart({ steps }) {
  const top = Math.max(1, steps[0]?.value || 1);
  return (
    <div className="funnel">
      {steps.map((step, i) => {
        const pctOfTop = (step.value / top) * 100;
        const previous = i > 0 ? steps[i - 1].value : null;
        const dropoff = previous ? Math.round(((previous - step.value) / previous) * 100) : null;
        return (
          <div key={step.key ?? `${step.label}-${i}`} className="funnel-step">
            <div className="f-label truncate">{step.label}</div>
            <div className="f-bar">
              <div className="f-fill" style={{ width: `${Math.max(6, pctOfTop)}%` }}>
                {number(step.value)}
              </div>
            </div>
            <div className="f-pct" title={dropoff !== null ? `${dropoff}% drop from previous stage` : ''}>
              {`${Math.round(pctOfTop)}%`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Compact inline sparkline for KPI cards and table cells. */
export function Sparkline({ values, width = 96, height = 26, color = 'var(--brand-500)' }) {
  if (!values?.length) return <span />;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const px = (i / Math.max(1, values.length - 1)) * width;
    const py = height - ((v - min) / range) * (height - 4) - 2;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Circular score gauge (0-100) used on the lead 360 page. */
export function ScoreRing({ score, size = 68, color = 'var(--brand-600)' }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  return (
    <div className="score-ring" style={{ width: `${size}px`, height: `${size}px`, flexBasis: `${size}px` }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={6} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="s-val" style={{ color }}>
        {String(Math.round(score))}
      </div>
    </div>
  );
}

/**
 * Grouped column chart, used for target vs actual.
 * @param groups     [{ label, [seriesKey]: number }]
 * @param seriesDefs [{ key, label, color? }]
 */
export function ColumnChart({ groups, seriesDefs, height = 250, formatValue = compactNumber }) {
  const width = 740;
  const pad = { top: 16, right: 12, bottom: 42, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...groups.flatMap((g) => seriesDefs.map((s) => g[s.key] || 0)));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step || 1;

  const groupW = plotW / Math.max(1, groups.length);
  const barW = Math.min(26, (groupW - 12) / seriesDefs.length);

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Comparison chart"
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const value = (niceMax / 4) * i;
          const yy = pad.top + plotH - (value / niceMax) * plotH;
          return (
            <g key={`grid${i}`}>
              <line x1={pad.left} x2={width - pad.right} y1={yy} y2={yy} stroke="var(--line-2)" />
              <text x={pad.left - 8} y={yy + 4} textAnchor="end" fontSize={10.5} fill="var(--ink-4)">
                {compactNumber(value)}
              </text>
            </g>
          );
        })}

        {groups.map((group, gi) => {
          const groupX = pad.left + gi * groupW;
          return (
            <g key={`g${gi}`}>
              {seriesDefs.map((s, si) => {
                const value = group[s.key] || 0;
                const barH = (value / niceMax) * plotH;
                const bx = groupX + (groupW - barW * seriesDefs.length) / 2 + si * barW;
                return (
                  <rect
                    key={s.key ?? si}
                    x={bx}
                    y={pad.top + plotH - barH}
                    width={Math.max(4, barW - 3)}
                    height={Math.max(1, barH)}
                    rx={3}
                    fill={s.color || PALETTE[si % PALETTE.length]}
                  >
                    <title>{`${group.label} · ${s.label}: ${formatValue(value)}`}</title>
                  </rect>
                );
              })}
              <text x={groupX + groupW / 2} y={height - 22} textAnchor="middle" fontSize={10.5} fill="var(--ink-4)">
                {group.label.length > 14 ? `${group.label.slice(0, 13)}…` : group.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {seriesDefs.map((s, i) => (
          <div key={s.key ?? i} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color || PALETTE[i % PALETTE.length] }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
