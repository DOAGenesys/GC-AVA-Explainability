'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FLOW_INSTANCE_TOPIC,
  MAX_CAPTURE_FLOWS,
  buildNotificationTopics,
  eventHighlights,
  extractExecutionPointer,
  isGenesysId,
  normalizeNotification,
  parseFlowIds,
  type ExecutionPointer,
} from '@/lib/notification-events';
import { CSRF_COOKIE, CSRF_HEADER } from '@/server/auth/cookies';

type ConnectionState = 'idle' | 'connecting' | 'live' | 'stopping' | 'closed' | 'error';
type ArchiveState =
  | 'queued'
  | 'retrieving'
  | 'archived'
  | 'no_history'
  | 'download_failed'
  | 'already_archived'
  | 'duplicate'
  | 'invalid';

interface CapturedEvent {
  id: number;
  receivedAt: string;
  topicName: string;
  body: unknown;
  raw: unknown;
  pointer: ExecutionPointer | null;
  archiveState: ArchiveState;
  bytes?: number;
  jobsStatusCode?: string | null;
}

interface ChannelResponse {
  channelId: string;
  connectUri: string;
  expires: string | null;
  topics: string[];
}

interface CaptureResponse {
  ok: boolean;
  apiCalls: number;
  results: {
    executionId: string;
    status: 'skipped_settled' | 'skipped_duplicate' | 'archived' | 'no_history' | 'download_failed';
    jobsStatusCode: string | null;
    bytes?: number;
  }[];
  metrics: {
    fetched: number;
    archived: number;
    noHistory: number;
    downloadFailed: number;
    skippedSettled: number;
    apiCallsPerExecution: number | null;
    jobs: unknown[];
  };
}

interface CaptureTotals {
  batches: number;
  jobs: number;
  apiCalls: number;
  fetched: number;
  archived: number;
  noHistory: number;
  failed: number;
  skipped: number;
  lastRatio: number | null;
}

interface FlowOption {
  flowId: string;
  name: string;
  flowType: string | null;
}

const MAX_EVENTS = 500;
const JOBS_BATCH_SIZE = 10;
const AUTO_FLUSH_MS = 30_000;
const EMPTY_TOTALS: CaptureTotals = {
  batches: 0,
  jobs: 0,
  apiCalls: 0,
  fetched: 0,
  archived: 0,
  noHistory: 0,
  failed: 0,
  skipped: 0,
  lastRatio: null,
};

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
      return 'Capture live';
    case 'stopping':
      return 'Finishing batch';
    case 'closed':
      return 'Capture stopped';
    case 'error':
      return 'Connection error';
    default:
      return 'Ready to capture';
  }
}

function archiveLabel(state: ArchiveState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'retrieving':
      return 'Retrieving trace';
    case 'archived':
      return 'Archived';
    case 'no_history':
      return 'No history';
    case 'download_failed':
      return 'Retry available';
    case 'already_archived':
      return 'Already handled';
    case 'duplicate':
      return 'Duplicate ignored';
    default:
      return 'Invalid pointer';
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

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function NotificationStream({ flowOptions }: { flowOptions: FlowOption[] }) {
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const [flowDraft, setFlowDraft] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [activeTopics, setActiveTopics] = useState<string[]>([]);
  const [expires, setExpires] = useState<string | null>(null);
  const [events, setEvents] = useState<CapturedEvent[]>([]);
  const [heartbeats, setHeartbeats] = useState(0);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [totals, setTotals] = useState<CaptureTotals>(EMPTY_TOTALS);
  const [error, setError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const channelAbortRef = useRef<AbortController | null>(null);
  const activeTopicsRef = useRef<string[]>([]);
  const sequenceRef = useRef(0);
  const stoppedRef = useRef(false);
  const failedRef = useRef(false);
  const seenExecutionIdsRef = useRef(new Set<string>());
  const pendingRef = useRef<ExecutionPointer[]>([]);
  const retryableRef = useRef(new Map<string, ExecutionPointer>());
  const flushInProgressRef = useRef(false);
  const flushRequestedRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const optionById = useMemo(
    () => new Map(flowOptions.map((flow) => [flow.flowId.toLowerCase(), flow])),
    [flowOptions],
  );
  const preview = useMemo(() => buildNotificationTopics({ flowIds }), [flowIds]);
  const locked = connection === 'connecting' || connection === 'live' || connection === 'stopping';
  const retryable = events.filter((event) => event.archiveState === 'download_failed').length;

  useEffect(() => {
    const warnOnPending = (event: BeforeUnloadEvent) => {
      if (
        pendingRef.current.length === 0 &&
        retryableRef.current.size === 0 &&
        !flushInProgressRef.current
      )
        return;
      event.preventDefault();
    };
    const archiveOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) persistPendingOnExit();
    };
    window.addEventListener('beforeunload', warnOnPending);
    window.addEventListener('pagehide', archiveOnPageHide);

    return () => {
      window.removeEventListener('beforeunload', warnOnPending);
      window.removeEventListener('pagehide', archiveOnPageHide);
      stoppedRef.current = true;
      channelAbortRef.current?.abort();
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
      persistPendingOnExit();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, []);

  function persistPendingOnExit() {
    const token = csrfToken();
    if (!token) return;

    const byExecution = new Map<string, ExecutionPointer>();
    for (const pointer of pendingRef.current) byExecution.set(pointer.executionId, pointer);
    for (const pointer of retryableRef.current.values()) {
      byExecution.set(pointer.executionId, pointer);
    }
    pendingRef.current = [];
    retryableRef.current.clear();

    const pointers = [...byExecution.values()];
    for (let start = 0; start < pointers.length; start += JOBS_BATCH_SIZE) {
      const batch = pointers.slice(start, start + JOBS_BATCH_SIZE);
      void fetch('/api/capture/executions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: token,
        },
        body: JSON.stringify({ executions: batch }),
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  function addFlows(candidates: string[]) {
    const normalized = parseFlowIds(candidates.join(','));
    if (normalized.length === 0) return;

    const invalid = normalized.filter((flowId) => !isGenesysId(flowId));
    if (invalid.length > 0) {
      setFlowError(
        `${invalid.length} ${invalid.length === 1 ? 'entry is not a valid flow ID' : 'entries are not valid flow IDs'}.`,
      );
      return;
    }

    const next = [...flowIds];
    const seen = new Set(flowIds);
    for (const flowId of normalized) {
      if (!seen.has(flowId)) next.push(flowId);
      seen.add(flowId);
    }
    if (next.length > MAX_CAPTURE_FLOWS) {
      setFlowError(`A capture can include up to ${MAX_CAPTURE_FLOWS} flows.`);
      return;
    }
    setFlowIds(next);
    setFlowError(null);
    setFlowDraft('');
  }

  function removeFlow(flowId: string) {
    setFlowIds((current) => current.filter((candidate) => candidate !== flowId));
  }

  function scheduleFlush() {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flushPending();
    }, AUTO_FLUSH_MS);
  }

  function updateEventStates(
    executionIds: Set<string>,
    update: Partial<Pick<CapturedEvent, 'archiveState' | 'bytes' | 'jobsStatusCode'>>,
  ) {
    setEvents((current) =>
      current.map((event) =>
        event.pointer && executionIds.has(event.pointer.executionId)
          ? { ...event, ...update }
          : event,
      ),
    );
  }

  async function postCaptureBatch(batch: ExecutionPointer[]): Promise<boolean> {
    const token = csrfToken();
    if (!token) {
      setError('The security token is missing. Reload the page before retrieving traces.');
      return false;
    }

    const executionIds = new Set(batch.map((pointer) => pointer.executionId));
    updateEventStates(executionIds, { archiveState: 'retrieving' });

    try {
      const response = await fetch('/api/capture/executions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: token,
        },
        body: JSON.stringify({ executions: batch }),
        keepalive: true,
      });
      const body = (await response.json().catch(() => null)) as
        CaptureResponse | { error?: { message?: string; nextAction?: string } } | null;
      if (!response.ok) {
        throw new Error(
          responseError(
            body as { error?: { message?: string; nextAction?: string } },
            response.status,
          ),
        );
      }

      const capture = body as CaptureResponse;
      for (const executionId of executionIds) retryableRef.current.delete(executionId);
      const resultByExecution = new Map(
        capture.results.map((result) => [result.executionId, result]),
      );
      setEvents((current) =>
        current.map((event) => {
          if (!event.pointer || !executionIds.has(event.pointer.executionId)) return event;
          const result = resultByExecution.get(event.pointer.executionId);
          if (!result) return { ...event, archiveState: 'download_failed' };
          const archiveState: ArchiveState =
            result.status === 'skipped_settled'
              ? 'already_archived'
              : result.status === 'skipped_duplicate'
                ? 'duplicate'
                : result.status;
          return {
            ...event,
            archiveState,
            bytes: result.bytes,
            jobsStatusCode: result.jobsStatusCode,
          };
        }),
      );
      setTotals((current) => ({
        batches: current.batches + 1,
        jobs: current.jobs + capture.metrics.jobs.length,
        apiCalls: current.apiCalls + capture.apiCalls,
        fetched: current.fetched + capture.metrics.fetched,
        archived: current.archived + capture.metrics.archived,
        noHistory: current.noHistory + capture.metrics.noHistory,
        failed: current.failed + capture.metrics.downloadFailed,
        skipped: current.skipped + capture.metrics.skippedSettled,
        lastRatio: capture.metrics.apiCallsPerExecution,
      }));
      setError(
        capture.ok ? null : 'The traces were archived, but capture accounting could not be saved.',
      );
      return true;
    } catch (cause) {
      for (const pointer of batch) retryableRef.current.set(pointer.executionId, pointer);
      updateEventStates(executionIds, { archiveState: 'download_failed' });
      setError(cause instanceof Error ? cause.message : 'The trace batch could not be retrieved.');
      return false;
    }
  }

  async function flushPending(options: { all?: boolean } = {}) {
    if (flushInProgressRef.current) {
      flushRequestedRef.current = true;
      return;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRef.current.length === 0) return;

    flushInProgressRef.current = true;
    setFlushing(true);
    try {
      do {
        const batch = pendingRef.current.splice(0, JOBS_BATCH_SIZE);
        setPendingCount(pendingRef.current.length);
        const completed = await postCaptureBatch(batch);
        if (!completed) break;
      } while (options.all && pendingRef.current.length > 0);
    } finally {
      flushInProgressRef.current = false;
      setFlushing(false);
    }

    const shouldContinue =
      pendingRef.current.length >= JOBS_BATCH_SIZE ||
      (flushRequestedRef.current && pendingRef.current.length > 0);
    flushRequestedRef.current = false;
    if (shouldContinue) void flushPending(options);
    else if (pendingRef.current.length > 0) scheduleFlush();
  }

  function queueExecution(pointer: ExecutionPointer) {
    const key = pointer.executionId.toLowerCase();
    if (seenExecutionIdsRef.current.has(key)) return false;
    seenExecutionIdsRef.current.add(key);
    pendingRef.current.push(pointer);
    setPendingCount(pendingRef.current.length);

    if (pendingRef.current.length >= JOBS_BATCH_SIZE) void flushPending();
    else scheduleFlush();
    return true;
  }

  async function startCapture() {
    if (preview.errors.length > 0) {
      setFlowError(preview.errors.join(' '));
      return;
    }
    const token = csrfToken();
    if (!token) {
      setError('The security token is missing. Reload the page and try again.');
      return;
    }

    setConnection('connecting');
    setError(null);
    setFlowError(null);
    stoppedRef.current = false;
    failedRef.current = false;

    try {
      const controller = new AbortController();
      channelAbortRef.current = controller;
      const response = await fetch('/api/notifications/channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: token,
        },
        body: JSON.stringify({ flowIds: preview.flowIds }),
        signal: controller.signal,
      });
      channelAbortRef.current = null;
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
      if (stoppedRef.current) return;
      activeTopicsRef.current = channel.topics;
      setActiveTopics(channel.topics);
      setExpires(channel.expires);

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
                : 'Genesys rejected one or more flow subscriptions.',
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

        const pointer = extractExecutionPointer(normalized.body);
        const queued = pointer ? queueExecution(pointer) : false;
        sequenceRef.current += 1;
        const captured: CapturedEvent = {
          id: sequenceRef.current,
          receivedAt,
          topicName: normalized.topicName,
          body: normalized.body,
          raw: normalized.raw,
          pointer,
          archiveState: pointer ? (queued ? 'queued' : 'duplicate') : 'invalid',
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
            `The live connection closed unexpectedly${event.code ? ` (code ${event.code})` : ''}. Start a new capture to reconnect.`,
          );
        }
      };
    } catch (cause) {
      channelAbortRef.current = null;
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setConnection('closed');
        return;
      }
      setConnection('error');
      setError(cause instanceof Error ? cause.message : 'The capture could not be started.');
    }
  }

  async function stopCapture() {
    const socket = socketRef.current;
    stoppedRef.current = true;
    failedRef.current = false;
    setConnection('stopping');
    channelAbortRef.current?.abort();
    channelAbortRef.current = null;
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
    socketRef.current = null;
    activeTopicsRef.current = [];
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    await flushPending({ all: true });
    setConnection('closed');
  }

  function retryFailed() {
    const failed = events
      .filter((event) => event.archiveState === 'download_failed' && event.pointer)
      .map((event) => event.pointer as ExecutionPointer);
    if (failed.length === 0) return;

    const queuedIds = new Set(pendingRef.current.map((pointer) => pointer.executionId));
    for (const pointer of failed) {
      retryableRef.current.delete(pointer.executionId);
      if (!queuedIds.has(pointer.executionId)) pendingRef.current.push(pointer);
    }
    const retryIds = new Set(failed.map((pointer) => pointer.executionId));
    updateEventStates(retryIds, { archiveState: 'queued' });
    setPendingCount(pendingRef.current.length);
    void flushPending({ all: true });
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
    <div className="live-console capture-console">
      <section className="capture-hero" aria-labelledby="capture-heading">
        <div className="capture-hero-copy">
          <span className="section-kicker">Zero-discovery capture</span>
          <h2 id="capture-heading">Turn live flow completions into full traces</h2>
          <p>
            One notification supplies all three identifiers the archive needs. Execution IDs wait
            briefly for company, then travel to the Jobs API in efficient batches of ten.
          </p>
          <div className="capture-path" aria-label="Capture path">
            <span>Flow event</span>
            <i aria-hidden="true">→</i>
            <span>Execution pointer</span>
            <i aria-hidden="true">→</i>
            <span>Jobs batch</span>
            <i aria-hidden="true">→</i>
            <span>Archived trace</span>
          </div>
        </div>
        <div className={`connection-badge is-${connection}`}>
          <span aria-hidden="true" />
          {statusLabel(connection)}
        </div>
      </section>

      <section className="subscription-builder flow-picker" aria-labelledby="flows-heading">
        <div className="builder-heading">
          <div>
            <span className="section-kicker">1 · Choose coverage</span>
            <h2 id="flows-heading">Flows to capture</h2>
            <p>
              Add one flow or paste an entire list. Every flow becomes one concrete subscription.
            </p>
          </div>
          <div className="topic-lockup">
            <span className="topic-lockup-icon" aria-hidden="true">
              <i />
            </span>
            <span>
              <strong>{FLOW_INSTANCE_TOPIC.label}</strong>
              <code>{FLOW_INSTANCE_TOPIC.template}</code>
            </span>
          </div>
        </div>

        <div className="flow-add-row">
          <label className="live-field flow-entry">
            <span>Flow IDs</span>
            <textarea
              value={flowDraft}
              disabled={locked}
              onChange={(event) => setFlowDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  addFlows(parseFlowIds(flowDraft));
                }
              }}
              placeholder="Paste one or several UUIDs, separated by commas or new lines"
              spellCheck={false}
              rows={2}
            />
          </label>
          <button
            className="btn-add-flow"
            type="button"
            disabled={locked || !flowDraft.trim()}
            onClick={() => addFlows(parseFlowIds(flowDraft))}
          >
            <PlusIcon /> Add flows
          </button>
        </div>

        {flowOptions.length > 0 ? (
          <div className="known-flow-row">
            <label>
              <span>Or choose a known AVA flow</span>
              <select
                disabled={locked}
                value=""
                onChange={(event) => addFlows([event.target.value])}
              >
                <option value="">Select a flow…</option>
                {flowOptions
                  .filter((flow) => !flowIds.includes(flow.flowId.toLowerCase()))
                  .map((flow) => (
                    <option key={flow.flowId} value={flow.flowId}>
                      {flow.name} · {flow.flowType ?? 'flow'}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={locked || flowOptions.length === flowIds.length}
              onClick={() => addFlows(flowOptions.map((flow) => flow.flowId))}
            >
              Add all known flows
            </button>
          </div>
        ) : null}

        {flowIds.length > 0 ? (
          <div className="flow-chip-list" aria-label={`${flowIds.length} selected flows`}>
            {flowIds.map((flowId) => {
              const option = optionById.get(flowId);
              return (
                <div className="flow-chip" key={flowId}>
                  <span className="flow-chip-index">{flowIds.indexOf(flowId) + 1}</span>
                  <span>
                    <strong>{option?.name ?? 'Flow'}</strong>
                    <code>{flowId}</code>
                  </span>
                  <button
                    type="button"
                    disabled={locked}
                    aria-label={`Remove ${option?.name ?? flowId}`}
                    onClick={() => removeFlow(flowId)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flow-picker-empty">
            <span aria-hidden="true">01</span>
            <p>Add the flows whose completed executions should enter this archive.</p>
          </div>
        )}

        {flowError ? (
          <div className="live-error" role="alert">
            <strong>Check the flow list</strong>
            <span>{flowError}</span>
          </div>
        ) : null}
        {error ? (
          <div className="live-error" role="alert">
            <strong>Capture problem</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="subscription-actions capture-actions">
          <button
            className="btn-live-primary"
            type="button"
            disabled={locked || preview.errors.length > 0}
            onClick={startCapture}
          >
            <span className="live-button-dot" aria-hidden="true" />
            {connection === 'connecting' ? 'Opening channel…' : 'Start capture'}
          </button>
          <button
            className="btn-live-secondary"
            type="button"
            disabled={connection !== 'live' && connection !== 'connecting'}
            onClick={() => void stopCapture()}
          >
            Stop and archive pending
          </button>
          <div className="capture-scope">
            <strong>
              {flowIds.length} {flowIds.length === 1 ? 'flow' : 'flows'}
            </strong>
            <span>1 channel · {flowIds.length} concrete topics</span>
          </div>
        </div>
      </section>

      <section className="event-console capture-monitor" aria-labelledby="events-heading">
        <header className="event-console-head">
          <div>
            <span className="section-kicker">2 · Capture and archive</span>
            <h2 id="events-heading">Execution stream</h2>
            <p aria-live="polite">
              {events.length.toLocaleString()} events · {heartbeats.toLocaleString()} heartbeats
              {lastActivity ? ` · Last activity ${timeLabel(lastActivity)}` : ''}
            </p>
          </div>
          <div className="event-actions">
            <button type="button" onClick={copySelection}>
              <CopyIcon /> Copy selected
            </button>
            <button
              type="button"
              disabled={events.length === 0}
              onClick={() =>
                copy(pretty(events.map((event) => event.raw)), `${events.length} events copied.`)
              }
            >
              <CopyIcon /> Copy all
            </button>
            <button
              type="button"
              disabled={events.length === 0 || pendingCount > 0 || flushing}
              onClick={() => setEvents([])}
            >
              Clear
            </button>
          </div>
        </header>

        <div className="capture-metrics">
          <div>
            <span>Pending batch</span>
            <strong>
              {pendingCount}
              <small> / {JOBS_BATCH_SIZE}</small>
            </strong>
            <i>
              <b style={{ width: `${Math.min(100, pendingCount * 10)}%` }} />
            </i>
          </div>
          <div>
            <span>Traces archived</span>
            <strong>{totals.archived}</strong>
            <small>{totals.noHistory} confirmed without history</small>
          </div>
          <div>
            <span>Jobs submitted</span>
            <strong>{totals.jobs}</strong>
            <small>{totals.batches} capture batches</small>
          </div>
          <div>
            <span>Last API efficiency</span>
            <strong>{totals.lastRatio?.toFixed(3) ?? '—'}</strong>
            <small>calls / execution · floor 0.2</small>
          </div>
        </div>

        <div className="event-toolbar capture-toolbar">
          <span className="channel-lifetime">
            {expires
              ? `${activeTopics.length} flows live · Channel expires ${new Date(expires).toLocaleString()}`
              : 'No active capture channel'}
          </span>
          <span>
            {pendingCount > 0
              ? `Auto-archive in ≤30 seconds${flushing ? ' · retrieving now' : ''}`
              : flushing
                ? 'Retrieving trace batch…'
                : 'Waiting for the next execution'}
          </span>
          <div>
            {retryable > 0 ? (
              <button type="button" disabled={flushing} onClick={retryFailed}>
                Retry {retryable} failed
              </button>
            ) : null}
            <button
              type="button"
              disabled={pendingCount === 0 || flushing}
              onClick={() => void flushPending({ all: true })}
            >
              {flushing ? 'Retrieving…' : 'Archive pending now'}
            </button>
          </div>
          {copyNotice ? (
            <span className="copy-notice" role="status">
              {copyNotice}
            </span>
          ) : null}
        </div>

        {events.length === 0 ? (
          <div className="event-empty capture-empty">
            <span className={connection === 'live' ? 'radar is-live' : 'radar'} aria-hidden="true">
              <i />
            </span>
            <strong>
              {connection === 'live' ? 'Capture is listening' : 'Your stream is ready'}
            </strong>
            <p>
              {connection === 'live'
                ? 'Complete a selected flow. Its execution pointer will appear immediately, then join the next efficient Jobs batch.'
                : 'Choose one or more flows above, then start capture. No discovery query or scheduled polling is involved.'}
            </p>
          </div>
        ) : (
          <div className="event-list">
            {events.map((event, index) => (
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
  const [open, setOpen] = useState(false);
  const highlights = eventHighlights(event.body);

  return (
    <article className={newest ? 'event-card is-newest' : 'event-card'}>
      <div className="event-card-head">
        <div className="event-index">#{event.id}</div>
        <div className="event-title">
          <strong>{FLOW_INSTANCE_TOPIC.label}</strong>
          <code>
            {event.pointer ? `Execution ${shortId(event.pointer.executionId)}` : event.topicName}
          </code>
        </div>
        <span className={`archive-badge is-${event.archiveState}`}>
          {event.archiveState === 'retrieving' ? <i aria-hidden="true" /> : null}
          {archiveLabel(event.archiveState)}
        </span>
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
          <span>
            {event.bytes ? `${event.bytes.toLocaleString()} trace bytes archived · ` : ''}
            Expand / collapse
          </span>
        </summary>
        <pre tabIndex={0}>{pretty(event.raw)}</pre>
      </details>
    </article>
  );
}
