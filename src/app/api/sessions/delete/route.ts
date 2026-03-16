import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const userId = req.headers.get('x-user-id');

    if (!db) {
      throw new Error('Firestore database not initialized. Check your environment variables.');
    }

    if (!id) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
    }

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 401 });
    }

    const docRef = db.collection('sessions').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Security check: only the owner can delete
    if (doc.data()?.userId !== userId) {
      return NextResponse.json({ error: 'Unauthorized to delete this session' }, { status: 403 });
    }

    await docRef.delete();

    return NextResponse.json({ message: 'Session deleted successfully' });
  } catch (error: any) {
    console.error('[API Delete Session] Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to delete session' }, { status: 500 });
  }
}
