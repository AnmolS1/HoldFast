'use client';

import { ReactNode } from "react";
import { Inter } from "next/font/google";
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { AuthProvider } from '@/contexts/AuthContext';
import { FileProvider } from '@/contexts/FileContext';
import theme from '@/theme';

import "@/styles/globals.css";
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({ children }: Readonly<{ children: ReactNode; }>) {
	return (
		<html lang="en">
			<body className={inter.className}>
				<ThemeProvider theme={theme}>
					<CssBaseline />
					<AuthProvider>
						<FileProvider>
							{children}
						</FileProvider>
					</AuthProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
