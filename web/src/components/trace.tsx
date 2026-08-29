import { Pill, formatMs } from './ui';
import type { NormalizedTraceItem, ParsedTrace } from '@/server/genesys/ava';

/**
 * The execution trace, rendered as what it actually is: an ordered list of things the flow did,
 * with the AVA's tool calls expanded to show the inputs it chose and the outputs it got back.
 *
 * Tool calls are the only items expanded by default. Everything else in an execution history is
 * state and variable bookkeeping - useful to have, but it is not what anyone opens this view to
 * read, and expanding all of it would bury the three lines that explain the conversation.
 */

const KIND_LABELS: Record<string, string> = {
  startedFlow: 'Flow started',
  startedState: 'State',
  startedBotState: 'Bot state',
  actionCallData: 'Tool call',
  actionWait: 'Wait',
  endedFlow: 'Flow ended',
  transitionedToState: 'Transition',
};

function prettyJson(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

function isEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

export function TraceTimeline({ trace }: { trace: ParsedTrace }) {
  return (
    <div className="timeline">
      {trace.items.map((item, index) => (
        <TraceRow key={`${item.ordinal}-${item.kind}-${index}`} item={item} trace={trace} />
      ))}
    </div>
  );
}

function TraceRow({ item, trace }: { item: NormalizedTraceItem; trace: ParsedTrace }) {
  const isTool = item.kind === 'actionCallData';
  const call = isTool ? trace.toolCalls.find((c) => c.ordinal === item.ordinal) : undefined;
  const failed = call ? !call.succeeded : false;

  const classes = ['tl-item'];
  if (isTool) classes.push('is-tool');
  if (failed) classes.push('is-failed');

  return (
    <div className={classes.join(' ')}>
      <div className="tl-head">
        <span className="tl-kind">{KIND_LABELS[item.kind] ?? item.kind}</span>
        {item.label ? <span className="tl-label">{item.label}</span> : null}
        {call ? (
          failed ? (
            <Pill tone="bad">Failure path</Pill>
          ) : (
            <Pill tone="good">Success</Pill>
          )
        ) : null}
        {call?.category ? <Pill tone="neutral">{call.category}</Pill> : null}
        {item.sincePreviousMs != null && item.sincePreviousMs > 0 ? (
          <span className="mono-id">+{formatMs(item.sincePreviousMs)}</span>
        ) : null}
        <span className="tl-time">{item.at ? item.at.slice(11, 23) : '—'}</span>
      </div>

      {call?.outputPathReason ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginTop: 4 }}>
          Output path: {call.outputPathReason}
          {call.outputPathReasonValue ? ` (${call.outputPathReasonValue})` : ''}
        </div>
      ) : null}

      {call ? (
        <div className="io-grid">
          {!isEmptyRecord(call.inputs) ? (
            <div className="io-block">
              <h4>Inputs the AVA chose</h4>
              <pre>{prettyJson(call.inputs)}</pre>
            </div>
          ) : null}
          {!isEmptyRecord(call.outputs) ? (
            <div className="io-block">
              <h4>{call.succeeded ? 'Outputs returned' : 'Failure outputs'}</h4>
              <pre>{prettyJson(call.outputs)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TraceSummary({ trace }: { trace: ParsedTrace }) {
  return (
    <div className="grid grid-kpi">
      <div className="kpi">
        <span className="kpi-label">Duration</span>
        <span className="kpi-value">{formatMs(trace.durationMs)}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Timeline items</span>
        <span className="kpi-value">{trace.items.length}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Tool calls</span>
        <span className="kpi-value">{trace.toolCalls.length}</span>
        <span className="kpi-note">
          {trace.toolCalls.filter((c) => !c.succeeded).length} on a failure path
        </span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Errors / warnings</span>
        <span className={trace.errorCount > 0 ? 'kpi-value accent' : 'kpi-value'}>
          {trace.errorCount} / {trace.warningCount}
        </span>
      </div>
    </div>
  );
}
