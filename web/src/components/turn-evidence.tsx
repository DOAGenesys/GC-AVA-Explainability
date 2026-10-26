import { Fragment } from 'react';
import { Empty, Pill, formatMs } from './ui';
import {
  describeSessionEnd,
  isToolFailure,
  type TurnSession,
  type TurnToolCall,
} from '@/lib/turn-evidence';

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

function Message({
  kind,
  text,
  turnLabel,
  at,
  result,
}: {
  kind: 'customer' | 'ava';
  text: string;
  turnLabel: number;
  at: string | null;
  result?: string | null;
}) {
  const isCustomer = kind === 'customer';
  return (
    <article className={`conversation-event message-event ${kind}`}>
      <div className="event-rail" aria-hidden="true">
        <span className="event-avatar">{isCustomer ? 'C' : 'A'}</span>
      </div>
      <div className="message-wrap">
        <div className="message-meta">
          <strong>{isCustomer ? 'Customer' : 'AVA'}</strong>
          <span>Turn {turnLabel}</span>
          {result ? <Pill tone="neutral">{result}</Pill> : null}
          <Pill tone="info">Reporting turn</Pill>
          {timeLabel(at) ? <time>{timeLabel(at)}</time> : null}
        </div>
        <div className="message-bubble">{text}</div>
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function ToolCallEvent({ call, turnLabel }: { call: TurnToolCall; turnLabel: number }) {
  const failed = isToolFailure(call);
  return (
    <article className="conversation-event tool-event">
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
            <span className="tool-kicker">Called during turn {turnLabel}</span>
            <strong>{call.toolName}</strong>
          </span>
          <span className="tool-summary-meta">
            <Pill tone={failed ? 'bad' : call.status ? 'good' : 'neutral'}>
              {call.status ?? 'Status unknown'}
            </Pill>
            {call.latencyMs != null ? (
              <span className="mono-id">{formatMs(call.latencyMs)}</span>
            ) : null}
            <span className="disclosure-icon" aria-hidden="true">
              +
            </span>
          </span>
        </summary>
        <div className="tool-detail">
          <dl className="turn-tool-facts">
            <Fact label="Tool type" value={call.toolType} />
            <Fact label="Origin" value={call.origin} />
            <Fact label="Invoked" value={timeLabel(call.dateInvoked)} />
            <Fact label="Tool ID" value={call.toolId} />
            <Fact label="Target" value={call.targetId} />
            <Fact label="Error" value={call.errorText} />
            <Fact label="Knowledge" value={call.knowledge?.knowledgeName ?? null} />
            <Fact label="Retrieval" value={call.knowledge?.retrievalStatus ?? null} />
            <Fact label="Answer" value={call.knowledge?.answerGenerationStatus ?? null} />
          </dl>
          <p className="tool-path">
            Reporting Turns records that the call happened and how it ended. The inputs the AVA
            chose and the outputs returned exist only in execution history.
          </p>
        </div>
      </details>
    </article>
  );
}

/** One sweep session as a conversation: customer input, tool calls, AVA prompts per turn. */
export function TurnEvidenceView({ session }: { session: TurnSession }) {
  if (session.turns.length === 0) {
    return <Empty title="No turns stored for this session" />;
  }
  const failures = session.turns
    .flatMap((turn) => turn.toolCalls)
    .filter((call) => isToolFailure(call)).length;
  const end = describeSessionEnd(session);

  return (
    <div className="conversation-pane">
      <div className="conversation-status" aria-label="Turn evidence summary">
        <div>
          <span className="status-label">Conversation source</span>
          <strong>Reporting Turns</strong>
        </div>
        <div>
          <span className="status-label">AVA</span>
          <strong>
            {session.agentName ?? 'Unknown'}
            {session.agentVersion ? ` · v${session.agentVersion}` : ''}
          </strong>
        </div>
        <div>
          <span className="status-label">Tool calls</span>
          <strong>
            {session.toolCallCount}
            {failures > 0 ? ` · ${failures} failed` : ''}
          </strong>
        </div>
        <div className="evidence-state">
          <Pill tone={end ? 'info' : 'warn'}>{end ?? 'No exit reported'}</Pill>
        </div>
      </div>

      {session.turnsTruncated ? (
        <div className="timeline-notice is-warning">
          <strong>Older turns were not stored.</strong>
          This session exceeded the per-session storage budget, so only its most recent turns are
          shown.
        </div>
      ) : null}

      <div className="conversation-stream">
        {session.turns.map((turn, index) => (
          <Fragment key={turn.key}>
            {turn.userInput ? (
              <Message
                kind="customer"
                text={turn.userInput}
                turnLabel={index + 1}
                at={turn.dateCreated}
              />
            ) : null}
            {turn.toolCalls.map((call, callIndex) => (
              <ToolCallEvent key={`${turn.key}:${callIndex}`} call={call} turnLabel={index + 1} />
            ))}
            {turn.botPrompts.map((prompt, promptIndex) => (
              <Message
                key={`${turn.key}:prompt:${promptIndex}`}
                kind="ava"
                text={prompt}
                turnLabel={index + 1}
                at={turn.dateCompleted ?? turn.dateCreated}
                result={promptIndex === turn.botPrompts.length - 1 ? turn.result : null}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
