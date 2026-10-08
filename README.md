# BigStorage - Google Drive Clone

A complete Google Drive clone built with Next.js, Material-UI, AWS S3, and AWS Cognito.

## Features

- **Authentication**: User registration and login via AWS Cognito
- **File Management**: Upload, download, delete files with AWS S3 storage
- **Folder Navigation**: Create folders and navigate through directory structure
- **File Preview**: Preview images, PDFs, and text files
- **Search**: Search through files and folders
- **File Sharing**: Share files with permission levels
- **Recent Files**: View recently accessed files
- **Trash**: Soft delete with restore functionality
- **Responsive Design**: Works on desktop and mobile devices

## Tech Stack

- **Frontend**: React, Next.js 14, TypeScript
- **UI Library**: Material-UI (MUI)
- **Authentication**: AWS Cognito
- **File Storage**: AWS S3
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18+ installed
- AWS account with S3 and Cognito configured
- Git

### AWS Setup

1. **Create an S3 Bucket**:
   - Go to AWS S3 console
   - Create a new bucket with appropriate permissions
   - Note down the bucket name and region

2. **Set up AWS Cognito**:
   - Create a User Pool in AWS Cognito
   - Configure app client settings
   - Note down the User Pool ID and Client ID

3. **Create IAM User** (for development):
   - Create IAM user with S3 and Cognito permissions
   - Generate access keys

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd BigStorage
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env.local
```

4. Fill in your AWS configuration in `.env.local`:
```bash
NEXT_PUBLIC_AWS_REGION=us-east-1
NEXT_PUBLIC_AWS_ACCESS_KEY_ID=your_access_key_here
NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY=your_secret_key_here
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_xxxxxxxxx
NEXT_PUBLIC_COGNITO_CLIENT_ID=your_client_id_here
NEXT_PUBLIC_S3_BUCKET=your-bucket-name
```

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser

## Project Structure

```
src/
├── app/                    # Next.js 14 app router
│   ├── api/               # API routes
│   │   ├── auth/         # Authentication endpoints
│   │   └── files/        # File management endpoints
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Home page
├── components/            # React components
│   ├── auth/             # Authentication components
│   ├── files/            # File management components
│   └── layout/           # Layout components
├── contexts/             # React contexts
│   ├── AuthContext.tsx   # Authentication state
│   └── FileContext.tsx   # File management state
├── types/                # TypeScript type definitions
├── utils/                # Utility functions
├── theme/                # MUI theme configuration
└── styles/               # Global styles
```

## Deployment

### Vercel Deployment

1. Connect your GitHub repository to Vercel
2. Add environment variables in Vercel dashboard
3. Deploy automatically on push to main branch

### Environment Variables for Production

Set these in your Vercel dashboard or deployment platform:

- `NEXT_PUBLIC_AWS_REGION`
- `NEXT_PUBLIC_AWS_ACCESS_KEY_ID`
- `NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_COGNITO_USER_POOL_ID`
- `NEXT_PUBLIC_COGNITO_CLIENT_ID`
- `NEXT_PUBLIC_S3_BUCKET`

## Features Overview

### Authentication
- User registration with email verification
- Secure login/logout
- Session management
- Protected routes

### File Management
- Drag & drop file upload
- Multiple file selection
- File progress tracking
- File type detection
- Thumbnail generation for images

### User Interface
- Material Design components
- Dark/light theme support
- Responsive grid and list views
- Breadcrumb navigation
- Context menus

### File Operations
- Create/delete folders
- Move files between folders
- File preview modal
- Download files
- Search functionality

## Development

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

### Code Style

- TypeScript for type safety
- ESLint for code linting
- Consistent component structure
- Material-UI design system

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Security

- All API routes are protected with authentication
- Environment variables for sensitive data
- Secure file upload handling
- CORS configuration
- Input validation

## License

MIT License - see LICENSE file for details

## Support

For support and questions, please open an issue in the GitHub repository.