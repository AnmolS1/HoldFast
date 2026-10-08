'use client';

import React from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Avatar,
  IconButton,
  Button,
  Alert,
  Chip,
} from '@mui/material';
import { InsertDriveFile, Folder, Restore, DeleteForever } from '@mui/icons-material';
import { formatDate, formatFileSize } from '@/utils/file-utils';

interface TrashFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  deletedAt: Date;
  originalPath: string;
}

export const TrashFiles: React.FC = () => {
  // Mock trash files data
  const trashFiles: TrashFile[] = [
    {
      id: '1',
      name: 'old-presentation.pptx',
      type: 'file',
      size: 2048576,
      deletedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      originalPath: '/Documents/Presentations',
    },
    {
      id: '2',
      name: 'temp-folder',
      type: 'folder',
      deletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      originalPath: '/Downloads',
    },
    {
      id: '3',
      name: 'draft-document.docx',
      type: 'file',
      size: 1024000,
      deletedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
      originalPath: '/Documents',
    },
  ];

  const handleRestore = (fileId: string) => {
    console.log('Restore file:', fileId);
    // Implement restore functionality
  };

  const handlePermanentDelete = (fileId: string) => {
    console.log('Permanently delete file:', fileId);
    // Implement permanent delete functionality
  };

  const handleEmptyTrash = () => {
    console.log('Empty trash');
    // Implement empty trash functionality
  };

  const getDaysInTrash = (deletedAt: Date) => {
    const now = new Date();
    const diff = now.getTime() - deletedAt.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    return days;
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" component="h1" gutterBottom sx={{ fontWeight: 600 }}>
            Trash
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Files in trash are deleted forever after 30 days
          </Typography>
        </Box>
        
        {trashFiles.length > 0 && (
          <Button
            variant="outlined"
            color="error"
            onClick={handleEmptyTrash}
            startIcon={<DeleteForever />}
          >
            Empty Trash
          </Button>
        )}
      </Box>

      {trashFiles.length > 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Items in trash are automatically deleted after 30 days. You can restore them or delete them permanently.
        </Alert>
      )}

      {trashFiles.length === 0 ? (
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
            Trash is empty
          </Typography>
          <Typography variant="body2">
            Files you delete will appear here for 30 days
          </Typography>
        </Box>
      ) : (
        <List>
          {trashFiles.map((file) => {
            const daysInTrash = getDaysInTrash(file.deletedAt);
            const daysRemaining = 30 - daysInTrash;
            
            return (
              <ListItem
                key={file.id}
                sx={{
                  borderRadius: 1,
                  mb: 1,
                  '&:hover': {
                    bgcolor: 'action.hover',
                  },
                }}
              >
                <ListItemIcon>
                  {file.type === 'folder' ? (
                    <Avatar sx={{ bgcolor: 'grey.400' }}>
                      <Folder />
                    </Avatar>
                  ) : (
                    <Avatar sx={{ bgcolor: 'grey.300' }}>
                      <InsertDriveFile />
                    </Avatar>
                  )}
                </ListItemIcon>
                
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography 
                        variant="body1"
                        sx={{ color: 'text.secondary', textDecoration: 'line-through' }}
                      >
                        {file.name}
                      </Typography>
                      <Chip
                        label={`${daysRemaining} days left`}
                        size="small"
                        color={daysRemaining <= 7 ? 'error' : 'default'}
                        variant="outlined"
                      />
                    </Box>
                  }
                  secondary={
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Original location: {file.originalPath}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 2, mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          Deleted {formatDate(file.deletedAt)}
                        </Typography>
                        {file.type === 'file' && file.size && (
                          <>
                            <Typography variant="caption" color="text.secondary">
                              •
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatFileSize(file.size)}
                            </Typography>
                          </>
                        )}
                      </Box>
                    </Box>
                  }
                />
                
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <IconButton
                    onClick={() => handleRestore(file.id)}
                    color="primary"
                    title="Restore"
                  >
                    <Restore />
                  </IconButton>
                  <IconButton
                    onClick={() => handlePermanentDelete(file.id)}
                    color="error"
                    title="Delete Forever"
                  >
                    <DeleteForever />
                  </IconButton>
                </Box>
              </ListItem>
            );
          })}
        </List>
      )}
    </Box>
  );
};