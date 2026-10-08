'use client';

import React, { useEffect, useState } from 'react';
import {
  Box,
  Toolbar,
  IconButton,
  Button,
  TextField,
  InputAdornment,
  Breadcrumbs,
  Link,
  Typography,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  ViewList,
  ViewModule,
  Search,
  CreateNewFolder,
  CloudUpload,
  NavigateNext,
} from '@mui/icons-material';
import { FileGrid } from './FileGrid';
import { FileList } from './FileList';
import { FileUpload } from './FileUpload';
import { useFiles } from '@/contexts/FileContext';
import { FileItem } from '@/types';

export const FileExplorer: React.FC = () => {
  const {
    files,
    currentFolder,
    viewMode,
    loading,
    error,
    breadcrumbs,
    selectedFiles,
    searchQuery,
    setViewMode,
    setSelectedFiles,
    setSearchQuery,
    createFolder,
    setCurrentFolder,
    setBreadcrumbs,
  } = useFiles();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);

  useEffect(() => {
    // Mock data for demonstration
    const mockFiles: FileItem[] = [
      {
        id: '1',
        name: 'Documents',
        type: 'folder',
        lastModified: new Date('2024-01-15'),
      },
      {
        id: '2',
        name: 'Images',
        type: 'folder',
        lastModified: new Date('2024-01-14'),
      },
      {
        id: '3',
        name: 'presentation.pptx',
        type: 'file',
        size: 2048576,
        lastModified: new Date('2024-01-13'),
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
      {
        id: '4',
        name: 'budget.xlsx',
        type: 'file',
        size: 1024000,
        lastModified: new Date('2024-01-12'),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ];
    
    // Only set mock data if no files exist
    if (files.length === 0) {
      // This would normally come from an API call
      setTimeout(() => {
        // setFiles(mockFiles);
      }, 1000);
    }
  }, [files.length]);

  const handleFileSelect = (fileId: string) => {
    if (selectedFiles.includes(fileId)) {
      setSelectedFiles(selectedFiles.filter(id => id !== fileId));
    } else {
      setSelectedFiles([...selectedFiles, fileId]);
    }
  };

  const handleFileDoubleClick = (file: FileItem) => {
    if (file.type === 'folder') {
      setCurrentFolder(file);
      setBreadcrumbs([...breadcrumbs, { id: file.id, name: file.name, path: `/${file.name}` }]);
    } else {
      // Open file preview
      window.open(file.url, '_blank');
    }
  };

  const handleMenuAction = (action: string, file: FileItem) => {
    switch (action) {
      case 'share':
        // Open share dialog
        break;
      case 'rename':
        // Open rename dialog
        break;
      case 'delete':
        // Delete file
        break;
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(newBreadcrumbs);
    
    if (index === 0) {
      setCurrentFolder(null);
    } else {
      // Set folder based on breadcrumb
    }
  };

  const handleCreateFolder = async () => {
    if (folderName.trim()) {
      try {
        await createFolder(folderName, currentFolder?.id);
        setFolderName('');
        setShowNewFolder(false);
      } catch (error) {
        console.error('Failed to create folder:', error);
      }
    }
  };

  const filteredFiles = files.filter(file =>
    file.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Box>
      <Toolbar
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          px: { xs: 2, sm: 3 },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexGrow: 1 }}>
          <TextField
            size="small"
            placeholder="Search files"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Search />
                </InputAdornment>
              ),
            }}
            sx={{ minWidth: 200 }}
          />
          
          <Button
            variant="contained"
            startIcon={<CloudUpload />}
            onClick={() => setUploadOpen(true)}
            size="small"
          >
            Upload
          </Button>
          
          <Button
            variant="outlined"
            startIcon={<CreateNewFolder />}
            onClick={() => setShowNewFolder(true)}
            size="small"
          >
            New Folder
          </Button>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton
            onClick={() => setViewMode('grid')}
            color={viewMode === 'grid' ? 'primary' : 'default'}
          >
            <ViewModule />
          </IconButton>
          <IconButton
            onClick={() => setViewMode('list')}
            color={viewMode === 'list' ? 'primary' : 'default'}
          >
            <ViewList />
          </IconButton>
        </Box>
      </Toolbar>

      <Box sx={{ p: 3 }}>
        <Breadcrumbs
          separator={<NavigateNext fontSize="small" />}
          sx={{ mb: 3 }}
        >
          {breadcrumbs.map((breadcrumb, index) => (
            <Link
              key={breadcrumb.id}
              component="button"
              variant="body1"
              onClick={() => handleBreadcrumbClick(index)}
              sx={{
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
            >
              {breadcrumb.name}
            </Link>
          ))}
        </Breadcrumbs>

        {showNewFolder && (
          <Box sx={{ mb: 3, display: 'flex', gap: 2, alignItems: 'center' }}>
            <TextField
              size="small"
              placeholder="Folder name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <Button onClick={handleCreateFolder} disabled={!folderName.trim()}>
              Create
            </Button>
            <Button onClick={() => setShowNewFolder(false)}>Cancel</Button>
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : filteredFiles.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              py: 8,
              color: 'text.secondary',
            }}
          >
            <Typography variant="h6" gutterBottom>
              {searchQuery ? 'No files found' : 'This folder is empty'}
            </Typography>
            <Typography variant="body2">
              {searchQuery
                ? 'Try adjusting your search terms'
                : 'Upload files or create folders to get started'}
            </Typography>
          </Box>
        ) : viewMode === 'grid' ? (
          <FileGrid
            files={filteredFiles}
            selectedFiles={selectedFiles}
            onFileSelect={handleFileSelect}
            onFileDoubleClick={handleFileDoubleClick}
            onMenuAction={handleMenuAction}
          />
        ) : (
          <FileList
            files={filteredFiles}
            selectedFiles={selectedFiles}
            onFileSelect={handleFileSelect}
            onFileDoubleClick={handleFileDoubleClick}
            onMenuAction={handleMenuAction}
          />
        )}
      </Box>

      <FileUpload
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        folderId={currentFolder?.id}
      />
    </Box>
  );
};