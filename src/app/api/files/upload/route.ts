import { NextRequest, NextResponse } from 'next/server';
import { 
  S3Client, 
  PutObjectCommand,
  GetObjectCommand 
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { awsConfig } from '@/utils/aws-config';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({
  region: awsConfig.region,
});

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const folderId = formData.get('folderId') as string;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
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

    const fileId = uuidv4();
    const fileName = file.name;
    const fileSize = file.size;
    const mimeType = file.type;
    
    const key = folderId ? `${folderId}/${fileId}_${fileName}` : `${fileId}_${fileName}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const putObjectCommand = new PutObjectCommand({
      Bucket: awsConfig.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      Metadata: {
        originalName: fileName,
        uploadedBy: 'user-id', // TODO: Extract from JWT
        uploadedAt: new Date().toISOString(),
      },
    });

    await s3Client.send(putObjectCommand);

    const getObjectCommand = new GetObjectCommand({
      Bucket: awsConfig.s3Bucket,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, getObjectCommand, { expiresIn: 3600 });

    const fileItem = {
      id: fileId,
      name: fileName,
      type: 'file' as const,
      size: fileSize,
      lastModified: new Date(),
      url,
      parentId: folderId || undefined,
      mimeType,
      isInTrash: false,
    };

    return NextResponse.json(fileItem);
  } catch (error: any) {
    console.error('File upload error:', error);
    return NextResponse.json(
      { error: error.message || 'Upload failed' },
      { status: 500 }
    );
  }
}