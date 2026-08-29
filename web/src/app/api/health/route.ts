import { NextResponse } from 'next/server';
import { getReadiness } from '@/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Unauthenticated liveness and readiness. Reports which env vars are missing, never their values. */
export async function GET(): Promise<NextResponse> {
  const readiness = getReadiness();
  return NextResponse.json(
    { status: readiness.missing.length === 0 ? 'ready' : 'incomplete', ...readiness },
    { status: 200 },
  );
}
