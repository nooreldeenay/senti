import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';

export async function POST(req: Request) {
  try {
    const { topic, plan, currentTopicId } = await req.json();
    const userId = req.headers.get('x-user-id');

    if (!db) {
      throw new Error('Firestore database not initialized. Check your environment variables.');
    }

    if (!topic || !plan) {
      return NextResponse.json({ error: 'Topic and plan are required' }, { status: 400 });
    }

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 401 });
    }

    const sessionData = {
      userId,
      topic,
      plan,
      currentTopicId: currentTopicId || null,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('sessions').add(sessionData);

    return NextResponse.json({ id: docRef.id, message: 'Session saved successfully' });
  } catch (error: any) {
    console.error('[API Save Session] Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to save session' }, { status: 500 });
  }
}
