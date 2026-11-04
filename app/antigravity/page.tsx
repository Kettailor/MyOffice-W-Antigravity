import type { Metadata } from 'next';
import AntigravityIde from '@/components/antigravity/AntigravityIde';

export const metadata: Metadata = {
  title: 'Antigravity IDE — My Office',
  description: 'Antigravity AI Agent IDE & Workspace Manager',
};

export default function AntigravityPage() {
  return <AntigravityIde />;
}
