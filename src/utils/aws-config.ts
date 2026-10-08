import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client } from '@aws-sdk/client-s3';

const region = process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';

export const cognitoClient = new CognitoIdentityProviderClient({
  region,
  credentials: {
    accessKeyId: process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY!,
  },
});

export const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY!,
  },
});

export const awsConfig = {
  region,
  userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID!,
  userPoolWebClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!,
  s3Bucket: process.env.NEXT_PUBLIC_S3_BUCKET!,
};