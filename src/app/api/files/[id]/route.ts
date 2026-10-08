import { NextRequest, NextResponse } from 'next/server';
import { 
  S3Client, 
  DeleteObjectCommand 
} from '@aws-sdk/client-s3';
import { awsConfig } from '@/utils/aws-config';

const s3Client = new S3Client({
  region: awsConfig.region,
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    const authHeader = request.headers.get('authorization');
    const accessToken = authHeader?.replace('Bearer ', '');

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Authorization required' },
        { status: 401 }
      );
    }

    const deleteCommand = new DeleteObjectCommand({
      Bucket: awsConfig.s3Bucket,
      Key: id, // In a real app, you'd need to map file ID to S3 key
    });

    await s3Client.send(deleteCommand);

    return NextResponse.json({ message: 'File deleted successfully' });
  } catch (error: any) {
    console.error('File deletion error:', error);
    return NextResponse.json(
      { error: error.message || 'Deletion failed' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    const authHeader = request.headers.get('authorization');
    const accessToken = authHeader?.replace('Bearer ', '');

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Authorization required' },
        { status: 401 }
      );
    }

    // In a real implementation, you'd fetch file metadata from a database
    // For now, return a mock response
    const file = {
      id,
      name: 'Example File',
      type: 'file' as const,
      size: 1024,
      lastModified: new Date(),
      mimeType: 'text/plain',
      isInTrash: false,
    };

    return NextResponse.json(file);
  } catch (error: any) {
    console.error('File fetch error:', error);
    return NextResponse.json(
      { error: error.message || 'File fetch failed' },
      { status: 500 }
    );
  }
}