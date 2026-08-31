/**
 * Settle whether execution traces are missing because the ingest client cannot see them, or
 * because the discovery query asks for them in a shape the endpoint does not understand.
 *
 * Those two causes look identical from the outside: `POST /flows/instances/query` answers 200 with
 * an empty entity list for an unrecognised body just as it does for an org with no execution data.
 * The only way to separate them is to ask about an execution that is known to exist, which is what
 * the `--execution` id is for - take it from the filename of an execution data export.
 *
 * If the Jobs API returns a download for that id, the archive holds it and the client can read it,
 * which leaves the discovery body as the only candidate. The query shapes are then tried in turn
 * to find which one the endpoint actually honours.
 *
 *   $env:GENESYS_INGEST_CLIENT_ID='...'
 *   $env:GENESYS_INGEST_CLIENT_SECRET='...'
 *   $env:GENESYS_REGION='mypurecloud.de'
 *   node scripts/probe-execution.mjs --execution <id> --conversation <id> --flow <id>
 *
 * Conversation content is not printed - only counts, ids and field names.
 */

/**
 * @param {string} name
 * @param {string | undefined} fallback
 */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

// Defaults are the execution exported from the Architect UI, so the script is runnable as-is.
const executionId = arg('execution', '2d99a529-a3a9-5bbb-8495-e77669c56a58');
const conversationId = arg('conversation', '7a4d8e6d-53de-5891-a916-78f31c24729d');
const flowId = arg('flow', '56155fa0-92cd-574b-b7cf-0fafad91fd2f');

for (const key of ['GENESYS_INGEST_CLIENT_ID', 'GENESYS_INGEST_CLIENT_SECRET', 'GENESYS_REGION']) {
  if (process.env[key]) continue;
  try {
    process.loadEnvFile(new URL('../.env.local', import.meta.url));
  } catch {
    // Reported below if the variable is still missing.
  }
}

const clientId = process.env.GENESYS_INGEST_CLIENT_ID;
const clientSecret = process.env.GENESYS_INGEST_CLIENT_SECRET;
const region = process.env.GENESYS_REGION;

if (!clientId || !clientSecret || !region) {
  console.error(
    'Set GENESYS_INGEST_CLIENT_ID, GENESYS_INGEST_CLIENT_SECRET and GENESYS_REGION (or put them\n' +
      'in web/.env.local). This probe is entirely about what those credentials can see.',
  );
  process.exit(1);
}

const apiHost = region.startsWith('api.') ? region : `api.${region}`;
const loginHost = apiHost.replace(/^api\./, 'login.');

/** @param {string} title */
function heading(title) {
  console.log(`\n=== ${title} ===`);
}

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
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<{ status: number, body: any, text: string }>}
 */
async function api(path, init = {}) {
  const res = await fetch(`https://${apiHost}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies are surfaced through `text`.
  }
  return { status: res.status, body, text };
}

console.log(`token OK (${apiHost})`);
console.log(`execution    ${executionId}`);
console.log(`conversation ${conversationId}`);
console.log(`flow         ${flowId}`);

// --------------------------------------------------------------- what the credentials can see
heading('token identity and divisions');

const me = await api('/api/v2/tokens/me');
if (me.status === 200) {
  console.log(`organization: ${me.body?.organization?.name ?? '(unknown)'}`);
  console.log(`oauth client: ${me.body?.oAuthClient?.name ?? me.body?.oAuthClient?.id ?? '(n/a)'}`);
} else {
  console.log(`GET /tokens/me -> HTTP ${me.status}`);
}

const divisions = await api('/api/v2/authorization/divisions?pageSize=100');
if (divisions.status === 200) {
  const entities = divisions.body?.entities ?? [];
  console.log(`divisions visible to this token: ${entities.length}`);
  for (const d of entities) {
    console.log(`  ${d.id}  ${d.homeDivision ? '(home) ' : ''}${d.name}`);
  }
} else {
  console.log(
    `GET /authorization/divisions -> HTTP ${divisions.status} ` +
      '(needs authorization:division:view; not fatal for ingestion)',
  );
}

// The flow's own division is the one that has to be in reach for discovery to return anything.
const flow = await api(`/api/v2/flows/${flowId}?deleted=false`);
if (flow.status === 200) {
  console.log(
    `flow "${flow.body?.name}" division: ${flow.body?.division?.id} (${flow.body?.division?.name})`,
  );
} else {
  console.log(`GET /flows/${flowId} -> HTTP ${flow.status}: the client cannot even read the flow.`);
}

// ------------------------------------------------------- what the query endpoint will accept
heading('query capabilities');

const caps = await api('/api/v2/flows/instances/querycapabilities');
console.log(`HTTP ${caps.status}`);
if (caps.status === 200) console.log(JSON.stringify(caps.body, null, 2));
else console.log(caps.text.slice(0, 600));

// --------------------------------------------------------------- the decisive read-by-id test
heading('jobs API for the known execution id');

const job = await api('/api/v2/flows/instances/jobs', {
  method: 'POST',
  body: { ids: [executionId] },
});
console.log(`POST /flows/instances/jobs -> HTTP ${job.status}`);
if (job.status >= 400) console.log(job.text.slice(0, 600));

const jobId = job.body?.id;
if (jobId) {
  let state = null;
  let entities = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await api(`/api/v2/flows/instances/jobs/${jobId}`);
    state = poll.body?.jobState ?? `HTTP ${poll.status}`;
    entities = poll.body?.entities ?? [];
    if (state !== 'Pending' && state !== 'Running') break;
  }
  console.log(`jobState: ${state}`);

  for (const entity of entities) {
    console.log(
      `  ${entity.id}  failed=${entity.failed}  statusCode=${entity.statusCode ?? '-'}  ` +
        `download=${entity.downloadUri ? 'yes' : 'no'}`,
    );
    if (!entity.downloadUri) continue;

    // Downloading proves the trace is reachable end to end, and its shape is what the parser has
    // to match, so the AVA action is summarised rather than just counted.
    const download = await fetch(entity.downloadUri);
    const text = await download.text();
    console.log(`  downloaded ${text.length} bytes (HTTP ${download.status})`);
    try {
      const trace = JSON.parse(text);
      const items = trace?.flow?.execution ?? [];
      const kinds = items.flatMap((item) => Object.keys(item));
      console.log(`  flow.execution items: ${items.length} -> ${kinds.join(', ')}`);

      const ava = items.find(
        (item) => item.actionCallAgenticVirtualAgent,
      )?.actionCallAgenticVirtualAgent;
      if (ava) {
        const turns = ava.execution ?? [];
        const tools = turns.flatMap((t) => t.turn?.tools ?? []);
        console.log(
          `  AVA action "${ava.actionName}": ${turns.length} turns, ${tools.length} tool calls ` +
            `-> ${tools.map((t) => t.toolName).join(', ')}`,
        );
      }
    } catch {
      console.log('  the download did not parse as JSON');
    }
  }
}

// ------------------------------------------------------ which discovery body actually works
heading('discovery query body shapes');

const shapes = [
  {
    label: 'superseded body: criteria / criteriaKey / values',
    body: {
      criteria: [{ criteriaKey: 'ConversationId', values: [conversationId], operator: 'eq' }],
    },
  },
  {
    label: 'CriteriaQuery: query / and / key+operator+value (ConversationId)',
    body: { query: [{ and: [{ key: 'ConversationId', operator: 'eq', value: conversationId }] }] },
  },
  {
    label: 'CriteriaQuery: query / and / key+operator+value (FlowId)',
    body: { query: [{ and: [{ key: 'FlowId', operator: 'eq', value: flowId }] }] },
  },
  {
    // Whether an `or` group restores batching decides whether discovery costs one call per
    // conversation or one per window. The known id goes last, so a group that only honours its
    // first predicate is caught rather than mistaken for a working batch.
    label: 'batching probe: or group, known conversation id last',
    body: {
      query: [
        {
          or: [
            {
              key: 'ConversationId',
              operator: 'eq',
              value: '00000000-0000-0000-0000-000000000000',
            },
            { key: 'ConversationId', operator: 'eq', value: conversationId },
          ],
        },
      ],
    },
  },
];

for (const shape of shapes) {
  const res = await api('/api/v2/flows/instances/query?pageSize=200', {
    method: 'POST',
    body: shape.body,
  });
  const entities = res.body?.entities ?? [];
  const hit = entities.some((e) => e.id === executionId);
  console.log(
    `\n${shape.label}\n  HTTP ${res.status}  entities=${entities.length}  ` +
      `known id present=${hit ? 'YES' : 'no'}`,
  );
  if (res.status >= 400) console.log(`  ${res.text.slice(0, 400)}`);
  else if (entities[0]) console.log(`  first entity keys: ${Object.keys(entities[0]).join(', ')}`);
}

console.log('\nDone.');
