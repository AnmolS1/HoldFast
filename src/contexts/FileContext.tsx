'use client';

import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { FileContextType, FileItem, BreadcrumbItem, ViewMode, FilePermissions } from '@/types';

interface FileState {
  files: FileItem[];
  currentFolder: FileItem | null;
  viewMode: ViewMode;
  loading: boolean;
  error: string | null;
  breadcrumbs: BreadcrumbItem[];
  selectedFiles: string[];
  searchQuery: string;
}

type FileAction =
  | { type: 'SET_FILES'; payload: FileItem[] }
  | { type: 'SET_CURRENT_FOLDER'; payload: FileItem | null }
  | { type: 'SET_VIEW_MODE'; payload: ViewMode }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_BREADCRUMBS'; payload: BreadcrumbItem[] }
  | { type: 'SET_SELECTED_FILES'; payload: string[] }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'ADD_FILE'; payload: FileItem }
  | { type: 'UPDATE_FILE'; payload: FileItem }
  | { type: 'REMOVE_FILE'; payload: string };

const initialState: FileState = {
  files: [],
  currentFolder: null,
  viewMode: 'grid',
  loading: false,
  error: null,
  breadcrumbs: [{ id: 'root', name: 'My Drive', path: '/' }],
  selectedFiles: [],
  searchQuery: '',
};

const fileReducer = (state: FileState, action: FileAction): FileState => {
  switch (action.type) {
    case 'SET_FILES':
      return { ...state, files: action.payload };
    case 'SET_CURRENT_FOLDER':
      return { ...state, currentFolder: action.payload };
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_BREADCRUMBS':
      return { ...state, breadcrumbs: action.payload };
    case 'SET_SELECTED_FILES':
      return { ...state, selectedFiles: action.payload };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'ADD_FILE':
      return { ...state, files: [...state.files, action.payload] };
    case 'UPDATE_FILE':
      return {
        ...state,
        files: state.files.map((file) =>
          file.id === action.payload.id ? action.payload : file
        ),
      };
    case 'REMOVE_FILE':
      return {
        ...state,
        files: state.files.filter((file) => file.id !== action.payload),
      };
    default:
      return state;
  }
};

const FileContext = createContext<FileContextType | undefined>(undefined);

export const useFiles = (): FileContextType => {
  const context = useContext(FileContext);
  if (!context) {
    throw new Error('useFiles must be used within a FileProvider');
  }
  return context;
};

interface FileProviderProps {
  children: React.ReactNode;
}

export const FileProvider: React.FC<FileProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(fileReducer, initialState);

  const setFiles = (files: FileItem[]) => {
    dispatch({ type: 'SET_FILES', payload: files });
  };

  const setCurrentFolder = (folder: FileItem | null) => {
    dispatch({ type: 'SET_CURRENT_FOLDER', payload: folder });
  };

  const setViewMode = (mode: ViewMode) => {
    dispatch({ type: 'SET_VIEW_MODE', payload: mode });
    localStorage.setItem('viewMode', mode);
  };

  const setLoading = (loading: boolean) => {
    dispatch({ type: 'SET_LOADING', payload: loading });
  };

  const setError = (error: string | null) => {
    dispatch({ type: 'SET_ERROR', payload: error });
  };

  const setBreadcrumbs = (breadcrumbs: BreadcrumbItem[]) => {
    dispatch({ type: 'SET_BREADCRUMBS', payload: breadcrumbs });
  };

  const setSelectedFiles = (files: string[]) => {
    dispatch({ type: 'SET_SELECTED_FILES', payload: files });
  };

  const setSearchQuery = (query: string) => {
    dispatch({ type: 'SET_SEARCH_QUERY', payload: query });
  };

  const uploadFile = async (file: File, folderId?: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const formData = new FormData();
      formData.append('file', file);
      if (folderId) formData.append('folderId', folderId);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const uploadedFile: FileItem = await response.json();
      dispatch({ type: 'ADD_FILE', payload: uploadedFile });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Upload failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const createFolder = async (name: string, parentId?: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/files/folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
        body: JSON.stringify({ name, parentId }),
      });

      if (!response.ok) {
        throw new Error('Folder creation failed');
      }

      const folder: FileItem = await response.json();
      dispatch({ type: 'ADD_FILE', payload: folder });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Folder creation failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const deleteFile = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/files/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Delete failed');
      }

      dispatch({ type: 'REMOVE_FILE', payload: id });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Delete failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const moveToTrash = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/files/${id}/trash`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Move to trash failed');
      }

      const updatedFile: FileItem = await response.json();
      dispatch({ type: 'UPDATE_FILE', payload: updatedFile });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Move to trash failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const restoreFromTrash = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/files/${id}/restore`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Restore failed');
      }

      const updatedFile: FileItem = await response.json();
      dispatch({ type: 'UPDATE_FILE', payload: updatedFile });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Restore failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const shareFile = async (fileId: string, userId: string, permissions: FilePermissions): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/files/${fileId}/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
        body: JSON.stringify({ userId, permissions }),
      });

      if (!response.ok) {
        throw new Error('Share failed');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Share failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const savedViewMode = localStorage.getItem('viewMode') as ViewMode;
    if (savedViewMode) {
      dispatch({ type: 'SET_VIEW_MODE', payload: savedViewMode });
    }
  }, []);

  const contextValue: FileContextType = {
    files: state.files,
    currentFolder: state.currentFolder,
    viewMode: state.viewMode,
    loading: state.loading,
    error: state.error,
    breadcrumbs: state.breadcrumbs,
    selectedFiles: state.selectedFiles,
    searchQuery: state.searchQuery,
    setFiles,
    setCurrentFolder,
    setViewMode,
    setLoading,
    setError,
    setBreadcrumbs,
    setSelectedFiles,
    setSearchQuery,
    uploadFile,
    createFolder,
    deleteFile,
    moveToTrash,
    restoreFromTrash,
    shareFile,
  };

  return (
    <FileContext.Provider value={contextValue}>
      {children}
    </FileContext.Provider>
  );
};