import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { userId, permissions } = await request.json();

    if (!userId || !permissions) {
      return NextResponse.json(
        { error: 'User ID and permissions are required' },
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

    // In a real implementation, you'd create a share record in the database
    const shareItem = {
      id: `share_${Date.now()}`,
      fileId: id,
      userId,
      permissions,
      sharedAt: new Date(),
    };

    return NextResponse.json({
      message: 'File shared successfully',
      share: shareItem,
    });
  } catch (error: any) {
    console.error('File share error:', error);
    return NextResponse.json(
      { error: error.message || 'Share failed' },
      { status: 500 }
    );
  }
}