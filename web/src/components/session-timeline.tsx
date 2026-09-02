import { ToolCallBlock } from './trace';
import { Empty, Pill, formatMs } from './ui';
import type {
  SessionTimeline,
  SessionTimelineEvent,
  ToolAssociation,
} from '@/lib/session-timeline';
import type { ToolCall } from '@/server/genesys/ava';

function timeLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function associationLabel(value: ToolAssociation): string {
  return value === 'trace-native' ? 'Trace-native link' : 'Trace link';
}

function MessageEvent({
  event,
}: {
  event: Extract<SessionTimelineEvent, { kind: 'customer' | 'ava' }>;
}) {
  const isCustomer = event.kind === 'customer';
  return (
    <article className={`conversation-event message-event ${event.kind}`}>
      <div className="event-rail" aria-hidden="true">
        <span className="event-avatar">{isCustomer ? 'C' : 'A'}</span>
      </div>
      <div className="message-wrap">
        <div className="message-meta">
          <strong>{isCustomer ? 'Customer' : 'AVA'}</strong>
          <span>Turn {event.turnLabel}</span>
          {event.action ? <span>{event.action}</span> : null}
          {event.actionResult ? <Pill tone="neutral">{event.actionResult}</Pill> : null}
          {event.source === 'trace' ? <Pill tone="info">Execution trace</Pill> : null}
          {timeLabel(event.at) ? <time>{timeLabel(event.at)}</time> : null}
        </div>
        <div className="message-bubble">{event.text}</div>
      </div>
    </article>
  );
}

function ToolEvent({
  call,
  turnLabel,
  association,
  unplaced = false,
}: {
  call: ToolCall;
  turnLabel?: number;
  association?: ToolAssociation;
  unplaced?: boolean;
}) {
  return (
    <article className={`conversation-event tool-event${unplaced ? ' is-unplaced' : ''}`}>
      <div className="event-rail" aria-hidden="true">
        <span className="tool-node">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M14.7 6.3a4 4 0 0 0-5 5L4 17a2.1 2.1 0 0 0 3 3l5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z" />
          </svg>
        </span>
      </div>
      <details className="tool-card">
        <summary>
          <span className="tool-summary-copy">
            <span className="tool-kicker">
              {unplaced ? 'Unlinked tool call' : `Triggered by customer turn ${turnLabel}`}
            </span>
            <strong>{call.toolName}</strong>
          </span>
          <span className="tool-summary-meta">
            <Pill tone={call.succeeded ? 'good' : 'bad'}>
              {call.succeeded ? 'Success' : 'Failure'}
            </Pill>
            {association ? (
              <span className="association">{associationLabel(association)}</span>
            ) : null}
            {call.latencyMs != null ? (
              <span className="mono-id">{formatMs(call.latencyMs)}</span>
            ) : null}
            <span className="disclosure-icon" aria-hidden="true">
              +
            </span>
          </span>
        </summary>
        <div className="tool-detail">
          <ToolCallBlock call={call} showName={false} />
        </div>
      </details>
    </article>
  );
}

export function SessionTimelineView({ timeline }: { timeline: SessionTimeline }) {
  if (timeline.events.length === 0) {
    return (
      <Empty title="No conversation events available">
        This session has no usable Jobs execution history.
      </Empty>
    );
  }

  return (
    <div className="conversation-pane">
      <div className="conversation-status" aria-label="Conversation evidence summary">
        <div>
          <span className="status-label">Conversation source</span>
          <strong>Execution trace</strong>
        </div>
        <div>
          <span className="status-label">Turn associations</span>
          <strong>Trace native</strong>
        </div>
        <div>
          <span className="status-label">AVA tools placed</span>
          <strong>
            {timeline.hasTrace ? `${timeline.placedTools}/${timeline.avaTools}` : 'Not available'}
          </strong>
        </div>
        <div className="evidence-state">
          <Pill
            tone={
              timeline.truncated || timeline.unplacedTools.length > 0
                ? 'warn'
                : timeline.hasTrace
                  ? 'good'
                  : 'neutral'
            }
          >
            {timeline.truncated
              ? 'Partial trace'
              : timeline.unplacedTools.length > 0
                ? 'Some tools unlinked'
                : timeline.hasTrace
                  ? 'Evidence aligned'
                  : 'Transcript only'}
          </Pill>
        </div>
      </div>

      {timeline.truncated ? (
        <div className="timeline-notice is-warning">
          <strong>The execution trace is partial.</strong>
          Linked tools are shown where the trace proves they occurred; missing activity remains
          unknown.
        </div>
      ) : null}
      <div className="conversation-stream">
        {timeline.events.map((event) =>
          event.kind === 'tool' ? (
            <ToolEvent
              key={event.id}
              call={event.call}
              turnLabel={event.turnLabel}
              association={event.association}
            />
          ) : (
            <MessageEvent key={event.id} event={event} />
          ),
        )}
      </div>

      {timeline.unplacedTools.length > 0 ? (
        <details className="timeline-appendix">
          <summary>
            <span>
              <strong>Unlinked AVA tool calls</strong>
              <small>
                The trace proves these calls happened, but not enough evidence exists to assign them
                to a specific AVA conversation turn.
              </small>
            </span>
            <Pill tone="warn">{timeline.unplacedTools.length}</Pill>
          </summary>
          <div className="appendix-body">
            {timeline.unplacedTools.map((call) => (
              <ToolEvent key={`unplaced:${call.ordinal}`} call={call} unplaced />
            ))}
          </div>
        </details>
      ) : null}

      {timeline.flowTools.length > 0 ? (
        <details className="timeline-appendix">
          <summary>
            <span>
              <strong>Flow-level actions</strong>
              <small>
                Authored in the surrounding Architect flow, not selected by the AVA model.
              </small>
            </span>
            <Pill tone="info">{timeline.flowTools.length}</Pill>
          </summary>
          <div className="appendix-body">
            {timeline.flowTools.map((call) => (
              <ToolEvent key={`flow:${call.ordinal}`} call={call} unplaced />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
