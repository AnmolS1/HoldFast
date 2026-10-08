import { NextRequest, NextResponse } from 'next/server';
import { 
  CognitoIdentityProviderClient, 
  SignUpCommand,
  ConfirmSignUpCommand 
} from '@aws-sdk/client-cognito-identity-provider';
import { awsConfig } from '@/utils/aws-config';

const cognitoClient = new CognitoIdentityProviderClient({
  region: awsConfig.region,
});

export async function POST(request: NextRequest) {
  try {
    const { username, email, password } = await request.json();

    if (!username || !email || !password) {
      return NextResponse.json(
        { error: 'Username, email, and password are required' },
        { status: 400 }
      );
    }

    const signUpCommand = new SignUpCommand({
      ClientId: awsConfig.userPoolWebClientId,
      Username: username,
      Password: password,
      UserAttributes: [
        {
          Name: 'email',
          Value: email,
        },
      ],
    });

    const response = await cognitoClient.send(signUpCommand);

    return NextResponse.json({
      message: 'User registered successfully',
      userSub: response.UserSub,
      codeDeliveryDetails: response.CodeDeliveryDetails,
    });
  } catch (error: any) {
    console.error('Sign up error:', error);
    return NextResponse.json(
      { error: error.message || 'Sign up failed' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { username, confirmationCode } = await request.json();

    if (!username || !confirmationCode) {
      return NextResponse.json(
        { error: 'Username and confirmation code are required' },
        { status: 400 }
      );
    }

    const confirmCommand = new ConfirmSignUpCommand({
      ClientId: awsConfig.userPoolWebClientId,
      Username: username,
      ConfirmationCode: confirmationCode,
    });

    await cognitoClient.send(confirmCommand);

    return NextResponse.json({
      message: 'Account confirmed successfully',
    });
  } catch (error: any) {
    console.error('Confirmation error:', error);
    return NextResponse.json(
      { error: error.message || 'Confirmation failed' },
      { status: 500 }
    );
  }
}