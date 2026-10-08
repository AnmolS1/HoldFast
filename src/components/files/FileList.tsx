'use client';

import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Checkbox,
  IconButton,
  Menu,
  MenuItem,
  Avatar,
  Box,
  Typography,
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

interface FileListProps {
  files: FileItem[];
  selectedFiles: string[];
  onFileSelect: (fileId: string) => void;
  onFileDoubleClick: (file: FileItem) => void;
  onMenuAction: (action: string, file: FileItem) => void;
}

export const FileList: React.FC<FileListProps> = ({
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
      return (
        <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main' }}>
          <Folder />
        </Avatar>
      );
    }

    if (file.thumbnail) {
      return (
        <Avatar
          src={file.thumbnail}
          sx={{ width: 32, height: 32 }}
          variant="rounded"
        />
      );
    }

    return (
      <Avatar sx={{ width: 32, height: 32, bgcolor: 'grey.300' }}>
        <InsertDriveFile />
      </Avatar>
    );
  };

  return (
    <>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  indeterminate={selectedFiles.length > 0 && selectedFiles.length < files.length}
                  checked={files.length > 0 && selectedFiles.length === files.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      files.forEach(file => onFileSelect(file.id));
                    } else {
                      selectedFiles.forEach(fileId => onFileSelect(fileId));
                    }
                  }}
                />
              </TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Size</TableCell>
              <TableCell>Modified</TableCell>
              <TableCell width="48"></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((file) => (
              <TableRow
                key={file.id}
                hover
                selected={selectedFiles.includes(file.id)}
                onClick={() => onFileSelect(file.id)}
                onDoubleClick={() => onFileDoubleClick(file)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={selectedFiles.includes(file.id)}
                    onChange={() => onFileSelect(file.id)}
                  />
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    {renderFileIcon(file)}
                    <Typography variant="body2" noWrap>
                      {file.name}
                    </Typography>
                  </Box>
                </TableCell>
                <TableCell>
                  {file.type === 'file' ? formatFileSize(file.size || 0) : '—'}
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color="text.secondary">
                    {formatDate(file.lastModified)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <IconButton
                    size="small"
                    onClick={(e) => handleMenuOpen(e, file)}
                  >
                    <MoreVert />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

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