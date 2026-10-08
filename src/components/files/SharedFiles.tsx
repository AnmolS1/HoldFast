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
  Chip,
} from '@mui/material';
import { InsertDriveFile, Folder, Person } from '@mui/icons-material';
import { formatDate, formatFileSize } from '@/utils/file-utils';

interface SharedFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified: Date;
  sharedBy: {
    name: string;
    avatar?: string;
  };
  permissions: 'view' | 'edit' | 'owner';
}

export const SharedFiles: React.FC = () => {
  // Mock shared files data
  const sharedFiles: SharedFile[] = [
    {
      id: '1',
      name: 'Team Presentation.pptx',
      type: 'file',
      size: 5242880,
      lastModified: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
      sharedBy: { name: 'John Smith' },
      permissions: 'edit',
    },
    {
      id: '2',
      name: 'Project Resources',
      type: 'folder',
      lastModified: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
      sharedBy: { name: 'Sarah Johnson' },
      permissions: 'view',
    },
    {
      id: '3',
      name: 'Marketing Assets.zip',
      type: 'file',
      size: 15728640,
      lastModified: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      sharedBy: { name: 'Mike Davis' },
      permissions: 'view',
    },
  ];

  const getPermissionChip = (permission: string) => {
    const configs = {
      owner: { label: 'Owner', color: 'primary' as const },
      edit: { label: 'Can edit', color: 'success' as const },
      view: { label: 'Can view', color: 'default' as const },
    };
    
    const config = configs[permission as keyof typeof configs] || configs.view;
    
    return (
      <Chip
        label={config.label}
        size="small"
        color={config.color}
        variant="outlined"
      />
    );
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" component="h1" gutterBottom sx={{ fontWeight: 600 }}>
        Shared with Me
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Files and folders others have shared with you
      </Typography>

      {sharedFiles.length === 0 ? (
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
            No shared files
          </Typography>
          <Typography variant="body2">
            Files shared with you will appear here
          </Typography>
        </Box>
      ) : (
        <List>
          {sharedFiles.map((file) => (
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
                  <Avatar sx={{ bgcolor: 'primary.main' }}>
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
                    <Typography variant="body1">{file.name}</Typography>
                    {getPermissionChip(file.permissions)}
                  </Box>
                }
                secondary={
                  <Box sx={{ mt: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Person sx={{ fontSize: 16, color: 'text.secondary' }} />
                      <Typography variant="caption" color="text.secondary">
                        Shared by {file.sharedBy.name}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(file.lastModified)}
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
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
};