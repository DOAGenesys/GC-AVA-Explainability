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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ENUM_LIKE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

/**
 * Render a value only when it identifies structure rather than conversation content.
 *
 * Numbers, dates and ids are what the mapping has to be fixed against, so they are shown. Free text
 * is what the customer actually said, so it is reduced to a length. This keeps the output safe to
 * paste into an issue while still being enough to correct the field names.
 *
 * @param {unknown} value
 */
function redact(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return `<${typeof value}>`;
  if (UUID.test(value)) return `${value}  (uuid)`;
  if (ISO_DATE.test(value)) return `${value}  (date)`;
  if (/^-?\d+$/.test(value)) return `"${value}"  (numeric string)`;
  // Enum-ish tokens carry no free text: no spaces, short, and drawn from an identifier alphabet.
  if (value.length <= 40 && !value.includes(' ') && ENUM_LIKE.test(value)) return `"${value}"`;
  return `<string, ${value.length} chars>`;
}

/**
 * Flatten an entity into `path: type = value` lines, so nested vs flat field placement is obvious.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {number} depth
 * @returns {string[]}
 */
function describeShape(node, path = '', depth = 0) {
  if (depth > 3 || node === null || typeof node !== 'object') {
    return [`${path || '(root)'} = ${redact(node)}`];
  }
  if (Array.isArray(node)) {
    if (node.length === 0) return [`${path}[] = empty array`];
    // One element is enough to reveal the element shape; the rest repeat it.
    return [
      `${path}[] = array of ${node.length}`,
      ...describeShape(node[0], `${path}[0]`, depth + 1),
    ];
  }
  return Object.keys(node).flatMap((key) =>
    describeShape(node[key], path ? `${path}.${key}` : key, depth + 1),
  );
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

  // ------------------------------------------------------------- how well are turns mapped
  // Turn rows are archived with the untouched entity in `raw`, so the field names the platform
  // actually uses can be recovered from the archive without a live probe or credentials.
  heading('turn mapping health');

  const { rows: mapping } = await db.query(`
    SELECT count(*)                                                   AS turns,
           count(*) FILTER (WHERE session_id IS NULL)                  AS null_session_id,
           count(*) FILTER (WHERE conversation_id IS NULL)             AS null_conversation_id,
           count(*) FILTER (WHERE sequence_number IS NULL)             AS null_sequence,
           count(*) FILTER (WHERE turn_start IS NULL)                  AS null_turn_start,
           count(*) FILTER (WHERE turn_id LIKE 'sha256:%')             AS content_hashed_keys
    FROM ava_turns
  `);
  console.table(mapping);
  console.log(
    'null_sequence and null_turn_start both high means the transcript cannot be ordered, which is\n' +
      'what produces a scrambled transcript and a "TURN ?" label.',
  );

  // Fidelity discovery is driven entirely by session conversation ids, so a null column here is a
  // complete explanation for executions never being discovered.
  heading('session mapping health (drives execution discovery)');

  const { rows: sessionMapping } = await db.query(`
    SELECT count(*)                                        AS sessions,
           count(*) FILTER (WHERE conversation_id IS NULL) AS null_conversation_id,
           count(*) FILTER (WHERE date_created IS NULL)    AS null_date_created
    FROM ava_sessions
  `);
  console.table(sessionMapping);

  const { rows: eligible } = await db.query(`
    SELECT count(DISTINCT conversation_id) AS conversations_fidelity_would_pick_up
    FROM ava_sessions
    WHERE conversation_id IS NOT NULL AND date_created > now() - interval '9 days'
  `);
  console.table(eligible);
  console.log(
    'If this is 0, the fidelity pass has nothing to ask the Jobs API about, which is why no\n' +
      'execution trace ever appears. The cause is upstream: session conversation ids are missing.',
  );

  // ------------------------------------------------------------- the shape the platform sends
  heading('observed turn entity shape');

  const { rows: rawFields } = await db.query(`
    SELECT key, jsonb_typeof(value) AS type, count(*) AS occurrences
    FROM ava_turns, jsonb_each(raw)
    GROUP BY 1, 2
    ORDER BY 1
  `);
  if (rawFields.length === 0) console.log('No turns archived yet, so there is no shape to report.');
  else console.table(rawFields);

  const { rows: sample } = await db.query(
    `SELECT raw FROM ava_turns ORDER BY ingested_at DESC LIMIT 1`,
  );
  if (sample.length > 0) {
    heading('sample turn, values redacted unless structurally identifying');
    console.log(describeShape(sample[0].raw).join('\n'));
  }

  // ------------------------------------------------------------------ live probe
  const clientId = process.env.GENESYS_INGEST_CLIENT_ID;
  const clientSecret = process.env.GENESYS_INGEST_CLIENT_SECRET;
  const region = process.env.GENESYS_REGION;

  // Restricted to flows that have actually produced sessions. Probing every AVA-flagged flow prints
  // dozens of identical empty sections and buries the ones carrying data.
  const { rows: flows } = await db.query(`
    SELECT f.flow_id, f.name
    FROM ava_flows f
    WHERE f.ava_enabled
      AND EXISTS (SELECT 1 FROM ava_sessions s WHERE s.flow_id = f.flow_id)
    ORDER BY f.last_seen_at DESC
    LIMIT 5
  `);

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
          // The key is session plus creation instant, because the platform sends no turn number.
          const keyable = entities.filter((e) => e.sessionId && e.dateCreated).length;
          console.log(`keyable (sessionId + dateCreated): ${keyable} / ${entities.length}`);
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

      // ------------------------------------------------------- why no execution is ever discovered
      // Discovery reports zero while the archive holds conversation ids to ask about, so the
      // question is whether the query is malformed, unpermitted, or simply has no data to return.
      heading('execution discovery probe');

      const capsRes = await fetch(`https://${apiHost}/api/v2/flows/instances/querycapabilities`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`querycapabilities: HTTP ${capsRes.status}`);
      if (capsRes.ok) {
        // Names the criteria this org is actually allowed to query by, which is the difference
        // between a wrong criteria key and genuinely absent execution data.
        console.log(JSON.stringify(await capsRes.json(), null, 2).slice(0, 2000));
      } else {
        console.log((await capsRes.text()).slice(0, 500));
      }

      const { rows: convRows } = await db.query(`
        SELECT DISTINCT conversation_id
        FROM ava_sessions
        WHERE conversation_id IS NOT NULL AND date_created > now() - interval '9 days'
        LIMIT 5
      `);
      const conversationIds = convRows.map((r) => r.conversation_id);
      console.log(`\nprobing ${conversationIds.length} archived conversation ids`);

      // Batched and single-value forms are both tried: a criteria that only accepts one value would
      // explain a query that succeeds and returns nothing.
      for (const values of [conversationIds, conversationIds.slice(0, 1)]) {
        if (values.length === 0) continue;
        const res = await fetch(`https://${apiHost}/api/v2/flows/instances/query?pageSize=200`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            criteria: [{ criteriaKey: 'ConversationId', values, operator: 'EQ' }],
          }),
        });
        const text = await res.text();
        console.log(`\n${values.length} id(s): HTTP ${res.status}`);
        try {
          const body = JSON.parse(text);
          if (!res.ok) console.log('error body:', JSON.stringify(body).slice(0, 600));
          else {
            console.log(`entities returned: ${(body.entities ?? []).length}`);
            if ((body.entities ?? []).length > 0) {
              console.log('entity field names:', Object.keys(body.entities[0]).join(', '));
            }
          }
        } catch {
          console.log(text.slice(0, 400));
        }
      }
    }
  }
} catch (err) {
  console.error('Diagnosis failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
