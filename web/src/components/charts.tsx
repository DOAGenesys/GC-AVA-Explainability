'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Charts, on the brand palette. Neutrals carry the field and the accent colours are reserved for
 * the things that need attention, so a chart's colour is never decorative: orange means a gap or a
 * failure, teal means a good outcome, azure and navy are the informational series.
 */

const NAVY = '#152550';
const ORANGE = '#ff451a';
const AZURE = '#2243a2';
const ARCTIC = '#b1cada';
const PATINA = '#18caa8';
const AMBER = '#f7ad00';

const AXIS = { stroke: '#8a97b0', fontSize: 11 } as const;
const GRID = '#e3e0d9';

const TOOLTIP_STYLE = {
  border: '1px solid #cfd8e3',
  borderRadius: 10,
  fontSize: 12,
  fontFamily: 'Roboto, Arial, sans-serif',
  boxShadow: '0 8px 24px rgba(21,37,80,0.1)',
} as const;

function toneFor(category: string): string {
  const value = category.toLowerCase();
  if (value.includes('contain')) return PATINA;
  if (value.includes('error') || value.includes('fail')) return ORANGE;
  if (value.includes('disconnect') || value.includes('abandon')) return AMBER;
  if (value.includes('transfer') || value.includes('exit')) return AZURE;
  return ARCTIC;
}

export function OutcomeDonut({ data }: { data: { category: string; count: number }[] }) {
  const summary = data.map((item) => `${item.category}: ${item.count}`).join(', ');
  return (
    <div className="chart-wrap" role="img" aria-label={`Session outcomes. ${summary}`}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="category"
            innerRadius={62}
            outerRadius={98}
            paddingAngle={2}
            stroke="#ffffff"
            strokeWidth={2}
          >
            {data.map((slice) => (
              <Cell key={slice.category} fill={toneFor(slice.category)} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend
            verticalAlign="bottom"
            height={36}
            formatter={(value: string) => (
              <span style={{ color: NAVY, fontSize: 12 }}>{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ToolBars({
  data,
}: {
  data: { toolName: string; calls: number; failures: number }[];
}) {
  const summary = data
    .map((item) => `${item.toolName}: ${item.calls} calls, ${item.failures} failures`)
    .join(', ');
  return (
    <div
      className="chart-wrap"
      style={{ height: Math.max(200, data.length * 42) }}
      role="img"
      aria-label={`Tool call volume and failures. ${summary}`}
    >
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 22 }} barSize={16}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" {...AXIS} allowDecimals={false} />
          <YAxis type="category" dataKey="toolName" width={190} {...AXIS} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: NAVY, fontSize: 12 }}>{value}</span>
            )}
          />
          <Bar dataKey="calls" name="Calls" fill={AZURE} radius={[0, 4, 4, 0]} />
          <Bar dataKey="failures" name="Failures" fill={ORANGE} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LatencyBars({
  data,
}: {
  data: { toolName: string; p50LatencyMs: number | null; p95LatencyMs: number | null }[];
}) {
  const summary = data
    .map(
      (item) =>
        `${item.toolName}: median ${item.p50LatencyMs ?? 'unknown'} milliseconds, 95th percentile ${item.p95LatencyMs ?? 'unknown'} milliseconds`,
    )
    .join(', ');
  return (
    <div
      className="chart-wrap"
      style={{ height: Math.max(200, data.length * 42) }}
      role="img"
      aria-label={`Tool latency. ${summary}`}
    >
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 22 }} barSize={16}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis
            type="number"
            {...AXIS}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`)}
          />
          <YAxis type="category" dataKey="toolName" width={190} {...AXIS} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`)}
          />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: NAVY, fontSize: 12 }}>{value}</span>
            )}
          />
          <Bar dataKey="p50LatencyMs" name="Median" fill={ARCTIC} radius={[0, 4, 4, 0]} />
          <Bar dataKey="p95LatencyMs" name="95th percentile" fill={NAVY} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CoverageBars({
  data,
}: {
  data: { category: string; sessions: number; withExecution: number }[];
}) {
  const shaped = data.map((row) => ({
    category: row.category,
    withExecution: row.withExecution,
    // The gap is the point of this chart: sessions the AVA genuinely handled that no execution
    // trace will ever explain.
    withoutExecution: row.sessions - row.withExecution,
  }));
  const summary = shaped
    .map(
      (item) =>
        `${item.category}: ${item.withExecution} full traces, ${item.withoutExecution} analytics only`,
    )
    .join(', ');

  return (
    <div
      className="chart-wrap"
      style={{ height: Math.max(220, shaped.length * 46) }}
      role="img"
      aria-label={`Execution coverage by outcome. ${summary}`}
    >
      <ResponsiveContainer>
        <BarChart data={shaped} layout="vertical" margin={{ left: 8, right: 22 }} barSize={20}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" {...AXIS} allowDecimals={false} />
          <YAxis type="category" dataKey="category" width={165} {...AXIS} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: NAVY, fontSize: 12 }}>{value}</span>
            )}
          />
          <Bar
            dataKey="withExecution"
            name="Full trace available"
            stackId="a"
            fill={PATINA}
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="withoutExecution"
            name="Analytics only"
            stackId="a"
            fill={ORANGE}
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BudgetLine({
  data,
}: {
  data: { at: string; apiCalls: number; perExecution: number | null }[];
}) {
  const summary = data
    .map(
      (item) =>
        `${item.at}: ${item.apiCalls} API calls${item.perExecution == null ? '' : `, ${item.perExecution} per execution`}`,
    )
    .join(', ');
  return (
    <div className="chart-wrap" role="img" aria-label={`API budget over time. ${summary}`}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ left: 4, right: 18, top: 8 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis dataKey="at" {...AXIS} />
          <YAxis yAxisId="calls" {...AXIS} allowDecimals={false} />
          <YAxis yAxisId="ratio" orientation="right" {...AXIS} domain={[0, 'auto']} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: NAVY, fontSize: 12 }}>{value}</span>
            )}
          />
          <Line
            yAxisId="calls"
            type="monotone"
            dataKey="apiCalls"
            name="API calls per run"
            stroke={AZURE}
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="ratio"
            type="monotone"
            dataKey="perExecution"
            name="Calls per execution"
            stroke={ORANGE}
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
