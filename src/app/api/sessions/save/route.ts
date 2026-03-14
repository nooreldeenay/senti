import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';

export async function POST(req: Request) {
  try {
    const { topic, plan, currentTopicId } = await req.json();

    if (!topic || !plan) {
      return NextResponse.json({ error: 'Topic and plan are required' }, { status: 400 });
    }

    const sessionData = {
      topic,
      plan, // This should be the array of LearningTopic objects
      currentTopicId: currentTopicId || null,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    // For now, we'll use a generic "sessions" collection. 
    // In a real app, this would be scoped to a userId.
    const docRef = await db.collection('sessions').add(sessionData);

    return NextResponse.json({ id: docRef.id, message: 'Session saved successfully' });
  } catch (error: any) {
    console.error('[API Save Session] Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to save session' }, { status: 500 });
  }
}
