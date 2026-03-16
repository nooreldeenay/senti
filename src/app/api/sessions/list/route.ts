import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const userId = req.headers.get('x-user-id');

    if (!userId) {
      console.error('[API List Sessions] Missing x-user-id header');
      return NextResponse.json({ sessions: [] });
    }

    if (!db) {
       throw new Error('Firestore database not initialized. Check your environment variables.');
    }

    const snapshot = await db.collection('sessions')
      .where('userId', '==', userId)
      .get();

    const sessions = snapshot.docs
      .map((doc: any) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          updatedAt: data.updatedAt || new Date().toISOString()
        };
      })
      .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return NextResponse.json({ sessions });
  } catch (error: any) {
    console.error('[API List Sessions] Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch sessions' }, { status: 500 });
  }
}
