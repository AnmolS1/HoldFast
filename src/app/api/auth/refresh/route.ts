import { NextRequest, NextResponse } from 'next/server';
import { 
  CognitoIdentityProviderClient, 
  InitiateAuthCommand 
} from '@aws-sdk/client-cognito-identity-provider';
import { awsConfig } from '@/utils/aws-config';

const cognitoClient = new CognitoIdentityProviderClient({
  region: awsConfig.region,
});

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await request.json();

    if (!refreshToken) {
      return NextResponse.json(
        { error: 'Refresh token is required' },
        { status: 400 }
      );
    }

    const refreshCommand = new InitiateAuthCommand({
      ClientId: awsConfig.userPoolWebClientId,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    });

    const response = await cognitoClient.send(refreshCommand);

    if (!response.AuthenticationResult) {
      return NextResponse.json(
        { error: 'Token refresh failed' },
        { status: 401 }
      );
    }

    return NextResponse.json({
      tokens: {
        AccessToken: response.AuthenticationResult.AccessToken,
        IdToken: response.AuthenticationResult.IdToken,
      },
    });
  } catch (error: any) {
    console.error('Token refresh error:', error);
    return NextResponse.json(
      { error: error.message || 'Token refresh failed' },
      { status: 500 }
    );
  }
}