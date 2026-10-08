'use client';

import React, { useCallback, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Paper,
} from '@mui/material';
import {
  CloudUpload,
  InsertDriveFile,
  Close,
  CheckCircle,
  Error,
} from '@mui/icons-material';
import { useDropzone } from 'react-dropzone';
import { useFiles } from '@/contexts/FileContext';
import { formatFileSize } from '@/utils/file-utils';

interface FileUploadProps {
  open: boolean;
  onClose: () => void;
  folderId?: string;
}

interface UploadFile {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  open,
  onClose,
  folderId,
}) => {
  const { uploadFile } = useFiles();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newUploadFiles = acceptedFiles.map(file => ({
      file,
      progress: 0,
      status: 'pending' as const,
    }));
    
    setUploadFiles(prev => [...prev, ...newUploadFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
  });

  const removeFile = (index: number) => {
    setUploadFiles(prev => prev.filter((_, i) => i !== index));
  };

  const uploadAllFiles = async () => {
    if (uploadFiles.length === 0) return;

    setIsUploading(true);

    for (let i = 0; i < uploadFiles.length; i++) {
      const uploadFileItem = uploadFiles[i];
      
      if (uploadFileItem.status !== 'pending') continue;

      try {
        // Update status to uploading
        setUploadFiles(prev => prev.map((item, index) => 
          index === i ? { ...item, status: 'uploading' as const, progress: 0 } : item
        ));

        // Simulate progress for demonstration
        const progressInterval = setInterval(() => {
          setUploadFiles(prev => prev.map((item, index) => {
            if (index === i && item.progress < 90) {
              return { ...item, progress: item.progress + 10 };
            }
            return item;
          }));
        }, 200);

        await uploadFile(uploadFileItem.file, folderId);

        clearInterval(progressInterval);

        // Update status to completed
        setUploadFiles(prev => prev.map((item, index) => 
          index === i ? { ...item, status: 'completed' as const, progress: 100 } : item
        ));
      } catch (error) {
        // Update status to error
        setUploadFiles(prev => prev.map((item, index) => 
          index === i ? { 
            ...item, 
            status: 'error' as const, 
            error: error instanceof Error ? error.message : 'Upload failed' 
          } : item
        ));
      }
    }

    setIsUploading(false);
  };

  const handleClose = () => {
    if (!isUploading) {
      setUploadFiles([]);
      onClose();
    }
  };

  const getStatusIcon = (status: UploadFile['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle color="success" />;
      case 'error':
        return <Error color="error" />;
      default:
        return <InsertDriveFile />;
    }
  };

  const allCompleted = uploadFiles.length > 0 && uploadFiles.every(f => f.status === 'completed');
  const hasErrors = uploadFiles.some(f => f.status === 'error');

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: { minHeight: 400 }
      }}
    >
      <DialogTitle>Upload Files</DialogTitle>
      
      <DialogContent>
        {uploadFiles.length === 0 ? (
          <Paper
            {...getRootProps()}
            sx={{
              border: 2,
              borderColor: isDragActive ? 'primary.main' : 'grey.300',
              borderStyle: 'dashed',
              borderRadius: 2,
              p: 4,
              textAlign: 'center',
              cursor: 'pointer',
              bgcolor: isDragActive ? 'primary.50' : 'transparent',
              '&:hover': {
                borderColor: 'primary.main',
                bgcolor: 'primary.50',
              },
            }}
          >
            <input {...getInputProps()} />
            <CloudUpload
              sx={{
                fontSize: 64,
                color: 'primary.main',
                mb: 2,
              }}
            />
            <Typography variant="h6" gutterBottom>
              {isDragActive ? 'Drop files here' : 'Drag & drop files here'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              or click to select files
            </Typography>
            <Button variant="outlined" component="span">
              Choose Files
            </Button>
          </Paper>
        ) : (
          <Box>
            <List>
              {uploadFiles.map((uploadFile, index) => (
                <ListItem
                  key={index}
                  secondaryAction={
                    !isUploading && uploadFile.status === 'pending' ? (
                      <IconButton
                        edge="end"
                        onClick={() => removeFile(index)}
                        size="small"
                      >
                        <Close />
                      </IconButton>
                    ) : null
                  }
                >
                  <ListItemIcon>
                    {getStatusIcon(uploadFile.status)}
                  </ListItemIcon>
                  <ListItemText
                    primary={uploadFile.file.name}
                    secondary={
                      <Box>
                        <Typography variant="caption" display="block">
                          {formatFileSize(uploadFile.file.size)}
                        </Typography>
                        {uploadFile.status === 'uploading' && (
                          <LinearProgress
                            variant="determinate"
                            value={uploadFile.progress}
                            sx={{ mt: 1 }}
                          />
                        )}
                        {uploadFile.status === 'error' && (
                          <Typography variant="caption" color="error">
                            {uploadFile.error}
                          </Typography>
                        )}
                      </Box>
                    }
                  />
                </ListItem>
              ))}
            </List>

            <Paper
              {...getRootProps()}
              sx={{
                border: 1,
                borderColor: 'grey.300',
                borderStyle: 'dashed',
                borderRadius: 1,
                p: 2,
                textAlign: 'center',
                cursor: isUploading ? 'not-allowed' : 'pointer',
                bgcolor: isDragActive ? 'primary.50' : 'transparent',
                mt: 2,
              }}
            >
              <input {...getInputProps()} disabled={isUploading} />
              <Typography variant="body2" color="text.secondary">
                {isDragActive ? 'Drop more files here' : 'Add more files'}
              </Typography>
            </Paper>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={isUploading}>
          {allCompleted ? 'Close' : 'Cancel'}
        </Button>
        {uploadFiles.length > 0 && (
          <Button
            onClick={uploadAllFiles}
            variant="contained"
            disabled={isUploading || allCompleted}
          >
            {isUploading ? 'Uploading...' : hasErrors ? 'Retry' : 'Upload All'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};