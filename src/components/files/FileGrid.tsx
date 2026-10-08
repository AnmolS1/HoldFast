'use client';

import React from 'react';
import {
  Grid,
  Card,
  CardActionArea,
  CardContent,
  CardMedia,
  Typography,
  Box,
  IconButton,
  Checkbox,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  Folder,
  InsertDriveFile,
  MoreVert,
  Share,
  Delete,
  Edit,
} from '@mui/icons-material';
import { FileItem } from '@/types';
import { formatFileSize, formatDate, getFileIcon } from '@/utils/file-utils';

interface FileGridProps {
  files: FileItem[];
  selectedFiles: string[];
  onFileSelect: (fileId: string) => void;
  onFileDoubleClick: (file: FileItem) => void;
  onMenuAction: (action: string, file: FileItem) => void;
}

export const FileGrid: React.FC<FileGridProps> = ({
  files,
  selectedFiles,
  onFileSelect,
  onFileDoubleClick,
  onMenuAction,
}) => {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [selectedFile, setSelectedFile] = React.useState<FileItem | null>(null);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, file: FileItem) => {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
    setSelectedFile(file);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedFile(null);
  };

  const handleMenuAction = (action: string) => {
    if (selectedFile) {
      onMenuAction(action, selectedFile);
    }
    handleMenuClose();
  };

  const renderFileIcon = (file: FileItem) => {
    if (file.type === 'folder') {
      return <Folder sx={{ fontSize: 48, color: 'primary.main' }} />;
    }

    if (file.thumbnail) {
      return (
        <CardMedia
          component="img"
          height="48"
          image={file.thumbnail}
          alt={file.name}
          sx={{ objectFit: 'cover', width: 48 }}
        />
      );
    }

    const iconName = getFileIcon(file.mimeType || '');
    return <InsertDriveFile sx={{ fontSize: 48, color: 'text.secondary' }} />;
  };

  return (
    <>
      <Grid container spacing={2}>
        {files.map((file) => (
          <Grid item xs={12} sm={6} md={4} lg={3} key={file.id}>
            <Card
              sx={{
                position: 'relative',
                cursor: 'pointer',
                '&:hover': {
                  boxShadow: 4,
                },
                ...(selectedFiles.includes(file.id) && {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                }),
              }}
            >
              <Box
                sx={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  zIndex: 1,
                }}
              >
                <Checkbox
                  checked={selectedFiles.includes(file.id)}
                  onChange={() => onFileSelect(file.id)}
                  size="small"
                  sx={{
                    color: 'white',
                    '&.Mui-checked': {
                      color: 'primary.main',
                    },
                  }}
                />
              </Box>

              <Box
                sx={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 1,
                }}
              >
                <IconButton
                  size="small"
                  onClick={(e) => handleMenuOpen(e, file)}
                  sx={{
                    color: 'white',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    '&:hover': {
                      backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    },
                  }}
                >
                  <MoreVert />
                </IconButton>
              </Box>

              <CardActionArea
                onClick={() => onFileSelect(file.id)}
                onDoubleClick={() => onFileDoubleClick(file)}
              >
                <Box
                  sx={{
                    p: 2,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    minHeight: 120,
                  }}
                >
                  {renderFileIcon(file)}
                  
                  <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                    <Typography
                      variant="body2"
                      component="div"
                      noWrap
                      sx={{ textAlign: 'center', maxWidth: 150 }}
                      title={file.name}
                    >
                      {file.name}
                    </Typography>
                    
                    {file.type === 'file' && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ textAlign: 'center', display: 'block', mt: 0.5 }}
                      >
                        {formatFileSize(file.size || 0)}
                      </Typography>
                    )}
                    
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ textAlign: 'center', display: 'block' }}
                    >
                      {formatDate(file.lastModified)}
                    </Typography>
                  </CardContent>
                </Box>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
      >
        <MenuItem onClick={() => handleMenuAction('share')}>
          <Share sx={{ mr: 1 }} />
          Share
        </MenuItem>
        <MenuItem onClick={() => handleMenuAction('rename')}>
          <Edit sx={{ mr: 1 }} />
          Rename
        </MenuItem>
        <MenuItem onClick={() => handleMenuAction('delete')}>
          <Delete sx={{ mr: 1 }} />
          Delete
        </MenuItem>
      </Menu>
    </>
  );
};