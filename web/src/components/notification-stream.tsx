'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NOTIFICATION_TOPICS,
  buildNotificationTopics,
  eventHighlights,
  normalizeNotification,
  notificationLabel,
  type NotificationTopicKey,
} from '@/lib/notification-events';
import { CSRF_COOKIE, CSRF_HEADER } from '@/server/auth/cookies';
import type { AvaFlowOption } from '@/server/db';

type ConnectionState = 'idle' | 'connecting' | 'live' | 'stopping' | 'closed' | 'error';

interface CapturedEvent {
  id: number;
  receivedAt: string;
  topicName: string;
  body: unknown;
  raw: unknown;
}

interface ChannelResponse {
  channelId: string;
  connectUri: string;
  expires: string | null;
  topics: string[];
}

const MAX_EVENTS = 500;

function csrfToken(): string | null {
  const prefix = `${CSRF_COOKIE}=`;
  const value = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function responseError(
  body: { error?: { message?: string; nextAction?: string } } | null,
  status: number,
): string {
  const message = body?.error?.message ?? `Genesys returned HTTP ${status}.`;
  return body?.error?.nextAction ? `${message} ${body.error.nextAction}` : message;
}

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting';
    case 'live':
      return 'Live';
    case 'stopping':
      return 'Stopping';
    case 'closed':
      return 'Stopped';
    case 'error':
      return 'Connection error';
    default:
      return 'Not connected';
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(new Date(value));
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export function NotificationStream({ flowOptions }: { flowOptions: AvaFlowOption[] }) {
  const [selected, setSelected] = useState<NotificationTopicKey[]>(['flow-instance']);
  const [flowId, setFlowId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [activeTopics, setActiveTopics] = useState<string[]>([]);
  const [expires, setExpires] = useState<string | null>(null);
  const [events, setEvents] = useState<CapturedEvent[]>([]);
  const [heartbeats, setHeartbeats] = useState(0);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeTopicsRef = useRef<string[]>([]);
  const sequenceRef = useRef(0);
  const stoppedRef = useRef(false);
  const failedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const preview = useMemo(
    () => buildNotificationTopics({ selected, flowId, conversationId }),
    [selected, flowId, conversationId],
  );
  const visibleEvents =
    filter === 'all' ? events : events.filter((event) => event.topicName === filter);
  const locked = connection === 'connecting' || connection === 'live' || connection === 'stopping';

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && activeTopicsRef.current.length > 0) {
        socket.send(
          JSON.stringify({
            message: 'unsubscribe',
            topics: activeTopicsRef.current,
            correlationId: `leave-${Date.now()}`,
          }),
        );
      }
      socket?.close(1000, 'Page closed');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, []);

  function toggleTopic(key: NotificationTopicKey) {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }

  async function startSubscription() {
    if (preview.errors.length > 0) {
      setError(preview.errors.join(' '));
      return;
    }
    const token = csrfToken();
    if (!token) {
      setError('The security token is missing. Reload the page and try again.');
      return;
    }

    setConnection('connecting');
    setError(null);
    stoppedRef.current = false;
    failedRef.current = false;

    try {
      const response = await fetch('/api/notifications/channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: token,
        },
        body: JSON.stringify({ selected, flowId, conversationId }),
      });
      const body = (await response.json().catch(() => null)) as
        ChannelResponse | { error?: { message?: string; nextAction?: string } } | null;
      if (!response.ok) {
        throw new Error(
          responseError(
            body as { error?: { message?: string; nextAction?: string } },
            response.status,
          ),
        );
      }

      const channel = body as ChannelResponse;
      activeTopicsRef.current = channel.topics;
      setActiveTopics(channel.topics);
      setExpires(channel.expires);
      setFilter('all');

      const socket = new WebSocket(channel.connectUri);
      socketRef.current = socket;

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            message: 'subscribe',
            topics: channel.topics,
            correlationId: `subscribe-${channel.channelId}`,
          }),
        );
        setLastActivity(new Date().toISOString());
        pingTimerRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ message: 'ping' }));
          }
        }, 60_000);
      };

      socket.onmessage = (message) => {
        const receivedAt = new Date().toISOString();
        setLastActivity(receivedAt);

        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          parsed = { unparsedMessage: String(message.data) };
        }

        const control =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        if (
          typeof control?.correlationId === 'string' &&
          control.correlationId.startsWith('subscribe-')
        ) {
          if (control.status === 'subscribed' && String(control.result) === '200') {
            setConnection('live');
            return;
          }
          if (control.status === 'error' || control.status === 'failed') {
            setConnection('error');
            setError(
              typeof control.message === 'string'
                ? control.message
                : 'Genesys rejected one or more topic subscriptions.',
            );
            failedRef.current = true;
            socket.close(1008, 'Subscription rejected');
            return;
          }
        }

        const normalized = normalizeNotification(parsed);
        if (normalized.topicName === 'channel.metadata') {
          setHeartbeats((count) => count + 1);
          return;
        }

        sequenceRef.current += 1;
        const captured: CapturedEvent = {
          id: sequenceRef.current,
          receivedAt,
          topicName: normalized.topicName,
          body: normalized.body,
          raw: normalized.raw,
        };
        setEvents((current) => [captured, ...current].slice(0, MAX_EVENTS));
      };

      socket.onerror = () => {
        setConnection('error');
        setError('The Genesys WebSocket reported a connection error.');
      };

      socket.onclose = (event) => {
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (socketRef.current === socket) socketRef.current = null;
        if (failedRef.current) {
          setConnection('error');
          return;
        }
        if (stoppedRef.current) {
          setConnection('closed');
          return;
        }
        setConnection(event.wasClean ? 'closed' : 'error');
        if (!event.wasClean) {
          setError(
            `The live connection closed unexpectedly${event.code ? ` (code ${event.code})` : ''}. Start a new subscription to reconnect.`,
          );
        }
      };
    } catch (cause) {
      setConnection('error');
      setError(cause instanceof Error ? cause.message : 'The subscription could not be started.');
    }
  }

  function stopSubscription() {
    const socket = socketRef.current;
    stoppedRef.current = true;
    failedRef.current = false;
    setConnection('stopping');
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          message: 'unsubscribe',
          topics: activeTopics,
          correlationId: `unsubscribe-${Date.now()}`,
        }),
      );
    }
    socket?.close(1000, 'Stopped by user');
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    socketRef.current = null;
    activeTopicsRef.current = [];
    setConnection('closed');
  }

  async function copy(value: string, notice: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(notice);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyNotice(null), 1800);
    } catch {
      setCopyNotice('Clipboard access was denied.');
    }
  }

  function copySelection() {
    const selection = window.getSelection()?.toString().trim();
    if (!selection) {
      setCopyNotice('Select a JSON fragment first.');
      return;
    }
    void copy(selection, 'Selected fragment copied.');
  }

  return (
    <div className="live-console">
      <section className="subscription-builder" aria-labelledby="subscription-heading">
        <div className="builder-heading">
          <div>
            <span className="section-kicker">Subscription builder</span>
            <h2 id="subscription-heading">Choose the signals to watch</h2>
            <p>
              WebSocket topics require concrete IDs; wildcards are available only on EventBridge and
              Process Automation transports.
            </p>
          </div>
          <div className={`connection-badge is-${connection}`}>
            <span aria-hidden="true" />
            {statusLabel(connection)}
          </div>
        </div>

        <div className="topic-grid">
          {NOTIFICATION_TOPICS.map((topic) => {
            const checked = selected.includes(topic.key);
            return (
              <label
                className={checked ? 'topic-option is-selected' : 'topic-option'}
                key={topic.key}
              >
                <span className="topic-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggleTopic(topic.key)}
                  />
                  <span aria-hidden="true">✓</span>
                </span>
                <span className="topic-option-copy">
                  <strong>{topic.label}</strong>
                  <code>{topic.template}</code>
                  <small>{topic.description}</small>
                  <span className="schema-fields">
                    {topic.fields.map((field) => (
                      <span key={field}>{field}</span>
                    ))}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="target-grid">
          {selected.some((key) => key !== 'conversation-flow-end') ? (
            <label className="live-field">
              <span>Flow ID</span>
              <input
                value={flowId}
                disabled={locked}
                onChange={(event) => setFlowId(event.target.value)}
                placeholder="56155fa0-92cd-574b-b7cf-0fafad91fd2f"
                list="known-ava-flows"
                spellCheck={false}
                autoComplete="off"
              />
              <small>Used by flow execution and flow configuration topics.</small>
              <datalist id="known-ava-flows">
                {flowOptions.map((flow) => (
                  <option key={flow.flowId} value={flow.flowId}>
                    {flow.name} · {flow.flowType ?? 'flow'}
                  </option>
                ))}
              </datalist>
            </label>
          ) : null}

          {selected.includes('conversation-flow-end') ? (
            <label className="live-field">
              <span>Conversation ID</span>
              <input
                value={conversationId}
                disabled={locked}
                onChange={(event) => setConversationId(event.target.value)}
                placeholder="7a4d8e6d-53de-5891-a916-78f31c24729d"
                spellCheck={false}
                autoComplete="off"
              />
              <small>Must be known before that conversation reaches its flow-end event.</small>
            </label>
          ) : null}
        </div>

        <div className="subscription-preview">
          <span>Topics that will be sent to Genesys</span>
          {preview.topics.length > 0 ? (
            preview.topics.map((topic) => <code key={topic}>{topic}</code>)
          ) : (
            <small>Complete the required identifiers to preview the concrete topics.</small>
          )}
        </div>

        {error ? (
          <div className="live-error" role="alert">
            <strong>Subscription problem</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="subscription-actions">
          <button
            className="btn-live-primary"
            type="button"
            disabled={locked || preview.errors.length > 0}
            onClick={startSubscription}
          >
            <span className="live-button-dot" aria-hidden="true" />
            {connection === 'connecting' ? 'Opening channel…' : 'Start subscription'}
          </button>
          <button
            className="btn-live-secondary"
            type="button"
            disabled={connection !== 'live'}
            onClick={stopSubscription}
          >
            Stop
          </button>
          <span className="subscription-cost">
            One Platform API call to create the channel; events stream without polling.
          </span>
        </div>
      </section>

      <section className="event-console" aria-labelledby="events-heading">
        <header className="event-console-head">
          <div>
            <span className="section-kicker">Live output</span>
            <h2 id="events-heading">Received events</h2>
            <p aria-live="polite">
              {events.length.toLocaleString()} captured · {heartbeats.toLocaleString()} channel
              heartbeats
              {lastActivity ? ` · Last activity ${timeLabel(lastActivity)}` : ''}
            </p>
          </div>
          <div className="event-actions">
            <button type="button" onClick={copySelection}>
              <CopyIcon /> Copy selected
            </button>
            <button
              type="button"
              disabled={visibleEvents.length === 0}
              onClick={() =>
                copy(
                  pretty(visibleEvents.map((event) => event.raw)),
                  `${visibleEvents.length} events copied.`,
                )
              }
            >
              <CopyIcon /> Copy all
            </button>
            <button type="button" disabled={events.length === 0} onClick={() => setEvents([])}>
              Clear
            </button>
          </div>
        </header>

        <div className="event-toolbar">
          <label>
            <span>Show</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All subscribed topics</option>
              {activeTopics.map((topic) => (
                <option key={topic} value={topic}>
                  {notificationLabel(topic)}
                </option>
              ))}
            </select>
          </label>
          <span className="channel-lifetime">
            {expires
              ? `Channel expires ${new Date(expires).toLocaleString()}`
              : 'No active channel'}
          </span>
          {copyNotice ? (
            <span className="copy-notice" role="status">
              {copyNotice}
            </span>
          ) : null}
        </div>

        {visibleEvents.length === 0 ? (
          <div className="event-empty">
            <span className={connection === 'live' ? 'radar is-live' : 'radar'} aria-hidden="true">
              <i />
            </span>
            <strong>
              {connection === 'live' ? 'Listening for events' : 'No events captured yet'}
            </strong>
            <p>
              {connection === 'live'
                ? 'Keep this page open and trigger the selected Genesys activity. New events will appear here immediately.'
                : 'Configure at least one topic and start a subscription.'}
            </p>
          </div>
        ) : (
          <div className="event-list">
            {visibleEvents.map((event, index) => (
              <EventCard
                key={event.id}
                event={event}
                newest={index === 0}
                onCopy={(value, notice) => void copy(value, notice)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EventCard({
  event,
  newest,
  onCopy,
}: {
  event: CapturedEvent;
  newest: boolean;
  onCopy: (value: string, notice: string) => void;
}) {
  const [open, setOpen] = useState(newest);
  const highlights = eventHighlights(event.body);

  return (
    <article className={newest ? 'event-card is-newest' : 'event-card'}>
      <div className="event-card-head">
        <div className="event-index">#{event.id}</div>
        <div className="event-title">
          <strong>{notificationLabel(event.topicName)}</strong>
          <code>{event.topicName}</code>
        </div>
        <time dateTime={event.receivedAt}>{timeLabel(event.receivedAt)}</time>
        <button
          type="button"
          className="copy-event"
          onClick={() => onCopy(pretty(event.raw), `Event #${event.id} copied.`)}
        >
          <CopyIcon /> Copy event
        </button>
      </div>

      {highlights.length > 0 ? (
        <div className="event-highlights">
          {highlights.map((entry) => (
            <button
              type="button"
              key={`${entry.key}-${entry.value}`}
              title={`Copy ${entry.key}`}
              onClick={() => onCopy(entry.value, `${entry.key} copied.`)}
            >
              <span>{entry.key}</span>
              <code>{entry.value}</code>
              <CopyIcon />
            </button>
          ))}
        </div>
      ) : null}

      <details
        className="event-json"
        open={open}
        onToggle={(toggle) => setOpen(toggle.currentTarget.open)}
      >
        <summary>
          <span>Complete JSON envelope</span>
          <span>Expand / collapse</span>
        </summary>
        <pre tabIndex={0}>{pretty(event.raw)}</pre>
      </details>
    </article>
  );
}
