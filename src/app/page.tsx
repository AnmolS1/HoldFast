'use client';

import { AuthGuard } from '@/components/auth/AuthGuard';
import { MainLayout } from '@/components/layout/MainLayout';

export default function Home() {
	return (
		<AuthGuard>
			<MainLayout />
		</AuthGuard>
	);
}
