import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: NextRequest) {
  try {
    const { name, parentId } = await request.json();

    if (!name) {
      return NextResponse.json(
        { error: 'Folder name is required' },
        { status: 400 }
      );
    }

    const authHeader = request.headers.get('authorization');
    const accessToken = authHeader?.replace('Bearer ', '');

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Authorization required' },
        { status: 401 }
      );
    }

    const folderId = uuidv4();

    const folder = {
      id: folderId,
      name,
      type: 'folder' as const,
      lastModified: new Date(),
      parentId: parentId || undefined,
      isInTrash: false,
    };

    return NextResponse.json(folder);
  } catch (error: any) {
    console.error('Folder creation error:', error);
    return NextResponse.json(
      { error: error.message || 'Folder creation failed' },
      { status: 500 }
    );
  }
}