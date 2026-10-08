import { NextRequest, NextResponse } from 'next/server';
import { 
  CognitoIdentityProviderClient, 
  GlobalSignOutCommand 
} from '@aws-sdk/client-cognito-identity-provider';
import { awsConfig } from '@/utils/aws-config';

const cognitoClient = new CognitoIdentityProviderClient({
  region: awsConfig.region,
});

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const accessToken = authHeader?.replace('Bearer ', '');

    if (accessToken) {
      const signOutCommand = new GlobalSignOutCommand({
        AccessToken: accessToken,
      });

      await cognitoClient.send(signOutCommand);
    }

    return NextResponse.json({
      message: 'Signed out successfully',
    });
  } catch (error: any) {
    console.error('Sign out error:', error);
    return NextResponse.json({
      message: 'Signed out successfully',
    });
  }
}