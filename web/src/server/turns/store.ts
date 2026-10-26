import 'server-only';

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import {
  toSweepFlowStatus,
  toTurnSession,
  toTurnSessionSummary,
  type SweepFlowStatus,
  type TurnSession,
  type TurnSessionSummary,
} from '@/lib/turn-evidence';
import { logger } from '@/server/logger';

/**
 * Read access to the server-side Reporting Turns sweep (DynamoDB in the AWS stack).
 *
 * Credentials come from Vercel's OIDC federation: the deployment's short-lived OIDC token is
 * exchanged for a role that can only Query and GetItem this table, so no AWS key exists to leak.
 * Without the three environment variables, or outside a Vercel deployment, every call reports
 * `not-configured` / `unavailable` and the pages render without turn evidence.
 */

export type TurnStoreResult<T> =
  { state: 'ready'; data: T } | { state: 'not-configured' } | { state: 'unavailable' };

const SWEEP_DAY = 'SWEEP';
const DAY_MS = 86_400_000;

interface TurnStoreConfig {
  tableName: string;
  region: string;
  roleArn: string;
}

function readConfig(): TurnStoreConfig | null {
  const tableName = process.env.AVA_TURNS_TABLE?.trim();
  const region = process.env.AVA_TURNS_AWS_REGION?.trim();
  const roleArn = process.env.AVA_TURNS_ROLE_ARN?.trim();
  if (!tableName || !region || !roleArn) return null;
  return { tableName, region, roleArn };
}

export function isTurnStoreConfigured(): boolean {
  return readConfig() !== null;
}

let client: { key: string; instance: DynamoDBClient } | null = null;

function getClient(config: TurnStoreConfig): DynamoDBClient {
  const key = `${config.region}|${config.roleArn}`;
  if (client?.key === key) return client.instance;
  const instance = new DynamoDBClient({
    region: config.region,
    credentials: awsCredentialsProvider({
      roleArn: config.roleArn,
      roleSessionName: 'gc-ava-explainability-web',
      clientConfig: { region: config.region },
    }),
  });
  client = { key, instance };
  return instance;
}

async function withStore<T>(
  operation: string,
  run: (db: DynamoDBClient, config: TurnStoreConfig) => Promise<T>,
): Promise<TurnStoreResult<T>> {
  const config = readConfig();
  if (!config) return { state: 'not-configured' };
  try {
    return { state: 'ready', data: await run(getClient(config), config) };
  } catch (error) {
    // Only the error class: AWS SDK messages can echo request identifiers and ARNs.
    logger.warn('turn_store_unavailable', {
      operation,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return { state: 'unavailable' };
  }
}

function utcDays(days: number, now = Date.now()): string[] {
  return Array.from({ length: days }, (_, index) =>
    new Date(now - index * DAY_MS).toISOString().slice(0, 10),
  );
}

async function queryDay(
  db: DynamoDBClient,
  tableName: string,
  day: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'day-index',
        KeyConditionExpression: '#day = :day',
        ExpressionAttributeNames: { '#day': 'day' },
        ExpressionAttributeValues: { ':day': { S: day } },
        ScanIndexForward: false,
        Limit: Math.min(limit - items.length, 500),
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) items.push(unmarshall(item));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < limit);
  return items;
}

/** Sessions whose first turn falls in the last `days` UTC days, newest first. */
export function listTurnSessions(
  days: number,
  limit: number,
): Promise<TurnStoreResult<TurnSessionSummary[]>> {
  return withStore('listTurnSessions', async (db, { tableName }) => {
    const sessions: TurnSessionSummary[] = [];
    for (const day of utcDays(days)) {
      if (sessions.length >= limit) break;
      const items = await queryDay(db, tableName, day, limit - sessions.length);
      for (const item of items) {
        const summary = toTurnSessionSummary(item);
        if (summary) sessions.push(summary);
      }
    }
    return sessions;
  });
}

export function getTurnSession(sessionId: string): Promise<TurnStoreResult<TurnSession | null>> {
  return withStore('getTurnSession', async (db, { tableName }) => {
    const { Item } = await db.send(
      new GetItemCommand({ TableName: tableName, Key: { pk: { S: `SESSION#${sessionId}` } } }),
    );
    return Item ? toTurnSession(unmarshall(Item)) : null;
  });
}

/** The sweep session recorded for a conversation, if any. */
export function findTurnSessionByConversation(
  conversationId: string,
): Promise<TurnStoreResult<TurnSession | null>> {
  return withStore('findTurnSessionByConversation', async (db, { tableName }) => {
    const { Items } = await db.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'conversation-index',
        KeyConditionExpression: 'conversationId = :id',
        ExpressionAttributeValues: { ':id': { S: conversationId } },
        Limit: 1,
      }),
    );
    const sessionId = Items?.[0] ? unmarshall(Items[0]).sessionId : null;
    if (typeof sessionId !== 'string') return null;
    const { Item } = await db.send(
      new GetItemCommand({ TableName: tableName, Key: { pk: { S: `SESSION#${sessionId}` } } }),
    );
    return Item ? toTurnSession(unmarshall(Item)) : null;
  });
}

/** Per-flow watermark and last-run counts written by the sweep. */
export function listSweepStatus(): Promise<TurnStoreResult<SweepFlowStatus[]>> {
  return withStore('listSweepStatus', async (db, { tableName }) => {
    const items = await queryDay(db, tableName, SWEEP_DAY, 1000);
    return items
      .map(toSweepFlowStatus)
      .filter((status): status is SweepFlowStatus => status !== null);
  });
}
