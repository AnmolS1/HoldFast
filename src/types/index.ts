export interface FileItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified: Date;
  url?: string;
  parentId?: string;
  isShared?: boolean;
  permissions?: FilePermissions;
  mimeType?: string;
  thumbnail?: string;
  isInTrash?: boolean;
  owner?: User;
}

export interface FilePermissions {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
}

export interface User {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  cognitoUserId: string;
}

export interface ShareItem {
  id: string;
  fileId: string;
  userId: string;
  permissions: FilePermissions;
  sharedAt: Date;
  expiresAt?: Date;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  path: string;
}

export type ViewMode = 'grid' | 'list';
export type SortBy = 'name' | 'size' | 'lastModified' | 'type';
export type SortOrder = 'asc' | 'desc';

export interface FileContextType {
  files: FileItem[];
  currentFolder: FileItem | null;
  viewMode: ViewMode;
  loading: boolean;
  error: string | null;
  breadcrumbs: BreadcrumbItem[];
  selectedFiles: string[];
  searchQuery: string;
  setFiles: (files: FileItem[]) => void;
  setCurrentFolder: (folder: FileItem | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setBreadcrumbs: (breadcrumbs: BreadcrumbItem[]) => void;
  setSelectedFiles: (files: string[]) => void;
  setSearchQuery: (query: string) => void;
  uploadFile: (file: File, folderId?: string) => Promise<void>;
  createFolder: (name: string, parentId?: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  moveToTrash: (id: string) => Promise<void>;
  restoreFromTrash: (id: string) => Promise<void>;
  shareFile: (fileId: string, userId: string, permissions: FilePermissions) => Promise<void>;
}

export interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signUp: (username: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}