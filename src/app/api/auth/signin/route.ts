import { NextRequest, NextResponse } from 'next/server';
import { 
  CognitoIdentityProviderClient, 
  GetUserCommand 
} from '@aws-sdk/client-cognito-identity-provider';
import { 
  CognitoUserPool, 
  CognitoUser, 
  AuthenticationDetails 
} from 'amazon-cognito-identity-js';
import { awsConfig } from '@/utils/aws-config';

const cognitoClient = new CognitoIdentityProviderClient({
  region: awsConfig.region,
});

const userPool = new CognitoUserPool({
  UserPoolId: awsConfig.userPoolId,
  ClientId: awsConfig.userPoolWebClientId,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password are required' },
        { status: 400 }
      );
    }

    return new Promise<NextResponse>((resolve, reject) => {
      const cognitoUser = new CognitoUser({
        Username: username,
        Pool: userPool,
      });

      const authDetails = new AuthenticationDetails({
        Username: username,
        Password: password,
      });

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: async (result) => {
          try {
            const accessToken = result.getAccessToken().getJwtToken();
            const refreshToken = result.getRefreshToken().getToken();
            const idToken = result.getIdToken().getJwtToken();

            const getUserCommand = new GetUserCommand({
              AccessToken: accessToken,
            });

            const userResponse = await cognitoClient.send(getUserCommand);

            const user = {
              id: userResponse.Username!,
              username: userResponse.Username!,
              email: userResponse.UserAttributes?.find(attr => attr.Name === 'email')?.Value || '',
              cognitoUserId: userResponse.Username!,
            };

            resolve(NextResponse.json({
              user,
              tokens: {
                AccessToken: accessToken,
                RefreshToken: refreshToken,
                IdToken: idToken,
              },
            }));
          } catch (error: any) {
            console.error('User info retrieval error:', error);
            resolve(NextResponse.json(
              { error: 'Failed to get user information' },
              { status: 500 }
            ));
          }
        },
        onFailure: (error) => {
          console.error('Authentication failed:', error);
          resolve(NextResponse.json(
            { error: error.message || 'Authentication failed' },
            { status: 401 }
          ));
        },
        newPasswordRequired: (userAttributes, requiredAttributes) => {
          resolve(NextResponse.json(
            { 
              error: 'New password required',
              requiresNewPassword: true,
              userAttributes,
              requiredAttributes 
            },
            { status: 200 }
          ));
        },
      });
    });
  } catch (error: any) {
    console.error('Sign in error:', error);
    return NextResponse.json(
      { error: error.message || 'Sign in failed' },
      { status: 500 }
    );
  }
}