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
import { InsertDriveFile, Folder } from '@mui/icons-material';
import { formatDate, formatFileSize } from '@/utils/file-utils';

interface RecentFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified: Date;
  thumbnail?: string;
}

export const RecentFiles: React.FC = () => {
  // Mock recent files data
  const recentFiles: RecentFile[] = [
    {
      id: '1',
      name: 'Quarterly Report.pdf',
      type: 'file',
      size: 2048576,
      lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    },
    {
      id: '2',
      name: 'Project Assets',
      type: 'folder',
      lastModified: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 hours ago
    },
    {
      id: '3',
      name: 'meeting-notes.docx',
      type: 'file',
      size: 1024000,
      lastModified: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    },
    {
      id: '4',
      name: 'budget-2024.xlsx',
      type: 'file',
      size: 512000,
      lastModified: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    },
  ];

  const getTimeAgo = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else {
      return 'Just now';
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" component="h1" gutterBottom sx={{ fontWeight: 600 }}>
        Recent Files
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Files and folders you've recently accessed
      </Typography>

      {recentFiles.length === 0 ? (
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
            No recent files
          </Typography>
          <Typography variant="body2">
            Files you access will appear here
          </Typography>
        </Box>
      ) : (
        <List>
          {recentFiles.map((file) => (
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
                ) : file.thumbnail ? (
                  <Avatar src={file.thumbnail} variant="rounded" />
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
                    <Chip
                      label={getTimeAgo(file.lastModified)}
                      size="small"
                      variant="outlined"
                      sx={{ ml: 1 }}
                    />
                  </Box>
                }
                secondary={
                  <Box sx={{ display: 'flex', gap: 2, mt: 0.5 }}>
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
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
};