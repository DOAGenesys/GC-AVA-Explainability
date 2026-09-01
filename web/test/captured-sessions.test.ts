import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@vercel/postgres', () => ({ sql: sqlMock }));

import { getSessionDetail, listSessions, upsertCapturedSession } from '@/server/db';
import type { FlowExecutionTrace } from '@/server/genesys/ava';

const EXECUTION_ID = '2d99a529-a3a9-5bbb-8495-e77669c56a58';
const FLOW_ID = '56155fa0-92cd-574b-b7cf-0fafad91fd2f';
const CONVERSATION_ID = '7a4d8e6d-53de-5891-a916-78f31c24729d';
const trace = JSON.parse(
  readFileSync(new URL('./fixtures/ava-execution-trace.json', import.meta.url), 'utf8'),
) as FlowExecutionTrace;

beforeEach(() => {
  sqlMock.mockReset();
});

describe('captured session materialization', () => {
  it('reuses a richer analytics session when the conversation and flow already match', async () => {
    sqlMock.mockResolvedValueOnce({ rows: [{ session_id: 'analytics-session' }] });

    await expect(
      upsertCapturedSession({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        conversationId: CONVERSATION_ID,
        trace: null,
        noHistory: true,
      }),
    ).resolves.toBe('analytics-session');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('creates a deterministic Jobs-backed session when analytics has no row', async () => {
    sqlMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(
      upsertCapturedSession({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        conversationId: CONVERSATION_ID,
        trace: null,
        noHistory: true,
      }),
    ).resolves.toBe(EXECUTION_ID);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});

describe('captured session reads', () => {
  it('projects trace outcome and AVA turns into the Sessions list', async () => {
    sqlMock.mockResolvedValueOnce({
      rows: [
        {
          session_id: EXECUTION_ID,
          flow_id: FLOW_ID,
          flow_name: null,
          conversation_id: CONVERSATION_ID,
          bot_result: null,
          bot_result_category: null,
          date_created: '2026-08-31T16:46:05.302Z',
          turn_count: '0',
          execution_id: EXECUTION_ID,
          retrieval_status: 'ARCHIVED',
          tool_call_count: '3',
          trace,
          source: 'capture',
        },
      ],
    });

    const sessions = await listSessions(7, 300);
    expect(sessions[0]).toMatchObject({
      sessionId: EXECUTION_ID,
      flowName: 'DO - AVA Explainability',
      botResult: 'DISCONNECT',
      botResultCategory: 'Execution capture',
      retrievalStatus: 'ARCHIVED',
      toolCallCount: 3,
      source: 'capture',
    });
    expect(sessions[0]?.turnCount).toBeGreaterThan(0);
  });

  it('resolves an execution id as a session detail for pre-fix captures', async () => {
    sqlMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          execution_id: EXECUTION_ID,
          flow_id: FLOW_ID,
          flow_name: 'DO - AVA Explainability',
          conversation_id: CONVERSATION_ID,
          start_date_time: '2026-08-31T16:46:05.302Z',
          end_date_time: '2026-08-31T16:47:45.242Z',
          retrieval_status: 'ARCHIVED',
          trace,
        },
      ],
    });

    await expect(getSessionDetail(EXECUTION_ID)).resolves.toMatchObject({
      sessionId: EXECUTION_ID,
      flowId: FLOW_ID,
      botResult: 'DISCONNECT',
      botResultCategory: 'Execution capture',
      executionId: EXECUTION_ID,
      retrievalStatus: 'ARCHIVED',
    });
  });
});
