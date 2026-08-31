/**
 * Work out why turn capture is empty, without guessing.
 *
 * There are only three possible explanations, and they need different fixes:
 *
 *   1. Ingestion never ran, or ran before a fix was deployed.  -> ingest_runs shows it
 *   2. The platform returns no turns for these flows.          -> the raw probe shows it
 *   3. We fetch turns but fail to parse or key them.           -> the probe shows entity shape
 *
 * This prints the evidence for each. It never writes anything.
 *
 * Run with:  npm run db:diagnose
 *
 *   $env:POSTGRES_URL='postgres://...'
 *   $env:GENESYS_INGEST_CLIENT_ID='...'      # optional, enables the live API probe
 *   $env:GENESYS_INGEST_CLIENT_SECRET='...'
 *   $env:GENESYS_REGION='mypurecloud.de'
 *   npm run db:diagnose
 *
 * Conversation content is deliberately not printed - only field names, counts and timestamps - so
 * the output is safe to paste into an issue.
 */

import { loadPostgresUrl, openDb } from './pg-client.mjs';

const connectionString = loadPostgresUrl();
if (!connectionString) {
  console.error('POSTGRES_URL is not set.');
  process.exit(1);
}

const { db } = await openDb(connectionString);

/** @param {string} title */
function heading(title) {
  console.log(`\n=== ${title} ===`);
}

try {
  // ------------------------------------------------------------------ what is in the archive
  heading('archive contents');

  const { rows: counts } = await db.query(`
    SELECT
      (SELECT count(*) FROM ava_flows)                        AS flows,
      (SELECT count(*) FROM ava_flows WHERE ava_enabled)      AS flows_ava_enabled,
      (SELECT count(*) FROM ava_sessions)                     AS sessions,
      (SELECT count(*) FROM ava_turns)                        AS turns,
      (SELECT count(*) FROM ava_executions)                   AS executions,
      (SELECT count(*) FROM ava_tool_calls)                   AS tool_calls,
      (SELECT min(date_created) FROM ava_sessions)            AS oldest_session,
      (SELECT max(date_created) FROM ava_sessions)            AS newest_session
  `);
  console.table(counts);

  // ------------------------------------------------------------------ did ingestion actually run
  heading('recent ingest runs (newest first)');

  const { rows: runs } = await db.query(`
    SELECT kind, started_at, ok, flows_scanned, sessions_seen, turns_seen,
           executions_discovered, executions_retrieved, api_calls, error
    FROM ingest_runs
    ORDER BY started_at DESC
    LIMIT 15
  `);
  if (runs.length === 0) console.log('No ingest runs recorded at all - the crons have never run.');
  else console.table(runs);

  // ------------------------------------------------------------------ live probe
  const clientId = process.env.GENESYS_INGEST_CLIENT_ID;
  const clientSecret = process.env.GENESYS_INGEST_CLIENT_SECRET;
  const region = process.env.GENESYS_REGION;

  const { rows: flows } = await db.query(
    `SELECT flow_id, name FROM ava_flows WHERE ava_enabled ORDER BY last_seen_at DESC`,
  );

  if (!clientId || !clientSecret || !region) {
    heading('live api probe');
    console.log(
      'Skipped: set GENESYS_INGEST_CLIENT_ID, GENESYS_INGEST_CLIENT_SECRET and GENESYS_REGION\n' +
        'to probe the reporting-turns endpoint directly. Without it, hypotheses 2 and 3 cannot be\n' +
        'separated.',
    );
  } else {
    const apiHost = region.startsWith('api.') ? region : `api.${region}`;
    const loginHost = apiHost.replace(/^api\./, 'login.');

    heading('genesys token');
    const tokenRes = await fetch(`https://${loginHost}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokenRes.ok) {
      console.error(`Token request failed: ${tokenRes.status}. Check the ingest credentials.`);
      process.exitCode = 1;
    } else {
      const { access_token: token } = await tokenRes.json();
      console.log(`OK (${apiHost})`);

      for (const flow of flows) {
        heading(`reportingturns probe: ${flow.name} (${flow.flow_id})`);

        const url = `https://${apiHost}/api/v2/analytics/botflows/${flow.flow_id}/reportingturns?pageSize=100`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        console.log(`HTTP ${res.status}`);

        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          console.log(`Non-JSON response: ${text.slice(0, 300)}`);
          continue;
        }

        if (!res.ok) {
          // Error bodies from Genesys carry a message and code, not customer data.
          console.log('Error body:', JSON.stringify(body).slice(0, 500));
          continue;
        }

        const entities = body.entities ?? [];
        console.log(`entities returned: ${entities.length}`);
        console.log(`nextUri present:   ${Boolean(body.nextUri)}`);

        if (entities.length > 0) {
          const first = entities[0];
          // Field names only - the values are conversation content.
          console.log('first entity field names:', Object.keys(first).join(', '));
          console.log('keying fields:', {
            hasId: 'id' in first,
            hasSessionId: Boolean(first.sessionId),
            hasConversationId: Boolean(first.conversation?.id),
            sequenceNumberType: typeof first.sequenceNumber,
          });
          const keyable = entities.filter(
            (e) => e.id || ((e.sessionId || e.conversation?.id) && e.sequenceNumber !== undefined),
          ).length;
          console.log(`keyable with current logic: ${keyable} / ${entities.length}`);
        } else {
          console.log(
            'The platform returned no turns for this flow. Either the flow produced none, or\n' +
              'they have aged out of the 10-day TTL.',
          );
        }

        // Sessions the archive holds for this flow, to compare against turn availability.
        const { rows: sessionRows } = await db.query(
          `SELECT count(*) AS sessions, min(date_created) AS oldest, max(date_created) AS newest
           FROM ava_sessions WHERE flow_id = $1`,
          [flow.flow_id],
        );
        console.log('archived sessions for this flow:', sessionRows[0]);
      }
    }
  }
} catch (err) {
  console.error('Diagnosis failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
