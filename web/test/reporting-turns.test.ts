import { describe, expect, it } from 'vitest';
import { reportingTurnsNextPath, validateReportingTurnsQuery } from '@/lib/reporting-turns';

const FLOW_ID = '56155fa0-92cd-574b-b7cf-0fafad91fd2f';
const SESSION_ID = '33b6e980-095b-51a7-ae3e-02be439ac4bc';
const INTERVAL = '2026-08-31T08:00:00.000Z/2026-09-02T08:00:00.000Z';

describe('division Reporting Turns query', () => {
  it('normalizes a valid filtered query', () => {
    expect(
      validateReportingTurnsQuery({
        botFlowId: FLOW_ID.toUpperCase(),
        interval: INTERVAL,
        language: 'en-US',
        askActionResults: ['GuardrailsViolation', 'SuccessCollection'],
      }),
    ).toEqual({
      ok: true,
      query: {
        botFlowId: FLOW_ID,
        interval: INTERVAL,
        language: 'en-US',
        askActionResults: ['GuardrailsViolation', 'SuccessCollection'],
      },
    });
  });

  it('rejects mutually exclusive session filters and overlong intervals', () => {
    expect(
      validateReportingTurnsQuery({
        botFlowId: FLOW_ID,
        interval: INTERVAL,
        sessionId: SESSION_ID,
        language: 'en-US',
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateReportingTurnsQuery({
        botFlowId: FLOW_ID,
        interval: '2026-08-01T00:00:00.000Z/2026-09-02T00:00:00.000Z',
      }),
    ).toMatchObject({ ok: false });
  });

  it('forwards only a continuation URI for the requested flow', () => {
    const valid =
      `/api/v2/analytics/botflows/${FLOW_ID}/divisions/reportingturns` +
      '?pageSize=250&after=a%2Fb%2Bc%3D';

    expect(reportingTurnsNextPath(valid, FLOW_ID)).toBe(valid);
    expect(reportingTurnsNextPath('/api/v2/users?pageSize=250&after=a%2Fb', FLOW_ID)).toBeNull();
  });
});
